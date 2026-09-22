---
date: 2026-09-21
title: Completed Document Email Attachment Toggle
---

## Context

Upstream issue: [#3383 — "Completion emails fail for all recipients when the sealed PDF exceeds the
SMTP provider message size limit"](https://github.com/documenso/documenso/issues/3383).

When an envelope completes, `send-document-completed-emails.handler.ts` fetches every envelope item's
sealed PDF and attaches all of them to the "Signing Complete!" email — for the owner and for every
notified recipient. There is no way to turn that off, and there is no size check anywhere in the path.
Two problems follow:

- **Transport size.** Providers cap message size, and base64 inflates the payload by ~37%. The reporter
  runs 2.18.0 self-hosted on the `SMTP_AUTH` transport against Oracle Cloud Infrastructure Email
  Delivery, which caps messages at 2 MB, so a sealed document over roughly 1.4 MB is already too large
  before headers. The provider returns a 500 and the send fails.
- **Policy.** Some organisations cannot put executed documents into email at all and want the recipient
  to authenticate against Documenso instead. This is the position taken in #2766.

The failure is not confined to one recipient. The recipient fan-out is a `Promise.all`, so one rejected
send rejects the whole job (#3038), and with no `io.runTask` checkpoint the job replays from the first
recipient across all three retries (#3190). A provider size cap rejects every send identically, so the
envelope is sealed and complete, nobody — including the owner — gets a completion email, and no
`EMAIL_SENT` audit rows are written because those are written after the send.

The link half of this already exists and needs no new work. The completion email template already
renders a **Download** button — `/sign/{token}/complete` for recipients, the team documents path for the
owner — and `/sign/$token/complete` serves the sealed PDF via `EnvelopeDownloadDialog`
(`apps/remix/app/routes/_recipient+/sign.$token+/complete.tsx:259`). So the change is not "add links",
it is "make the attachment optional, and stop it breaking sends when it is too big for the transport".

## Current State

**Everything in this plan is implemented and pushed** on
`feat/completed-document-email-attachment-toggle`, in three commits:

- `a5e6e7199` — the per-envelope setting, the env-var cap, the extracted helper and the UI.
- `e67757fff` — Design §A–§E: the env var rename, the per-transport fallback, whole-message
  measurement, the storage size probe and the in-email notice.
- `b3baaef45` — §F, logging for the paths that skip a send.

What `a5e6e7199` established, unchanged except where the later commits amend it:

- **Setting.** `attachCompletedDocument` is in `ZDocumentEmailSettingsSchema` with `.default(true)`, has
  a `DocumentEmailEvents.AttachCompletedDocument` member (the enum drives the checkbox `id`/`htmlFor`
  and the `hiddenEvents` machinery, which is why an option rather than an event gets one), and is
  preserved — not forced false — in the non-`EMAIL` branch of `extractDerivedDocumentEmailSettings`,
  because the owner completion email still sends under `distributionMethod: NONE`. Living in the
  existing `emailSettings` JSON means no Prisma migration, and org/team defaults, template carry-over,
  the v1/v2 API surface and the audit-log diff all come for free.
- **Constant.** `MAX_COMPLETED_DOCUMENT_ATTACHMENT_SIZE()` parses the cap env var with the `null`
  (unset) / `0` (never attach) / `n` (cap) distinction. It is a function, not a module const, so
  `vi.stubEnv` works. The var was `NEXT_PRIVATE_SMTP_MAX_ATTACHMENT_SIZE` here and is renamed by §A.
  Covered by `packages/lib/constants/email.test.ts`.
- **Helper.** `shouldAttachCompletedDocuments` is extracted and unit-tested in
  `packages/lib/utils/email-attachments.test.ts`.
- **Handler.** The settings lookup is hoisted above the attachment build; the build short-circuits on
  `!attachCompletedDocument`, `cap === 0`, or both completion emails being off; a non-zero cap that
  trips logs `io.logger.warn`.
- **UI.** The checkbox and tooltip are in `document-email-checkboxes.tsx`, which feeds all six surfaces
  at once (envelope editor settings dialog, legacy document flow, templates, embed authoring, org/team
  email preferences, admin global settings). `AttachCompletedDocument` is deliberately **not** in
  `RECIPIENT_EMAIL_EVENTS`, so it stays visible under non-email distribution. Asserted by
  `envelope-settings.spec.ts` and `organisation-team-preferences.spec.ts`.
- **Docs.** `environment.mdx`, `email.mdx` and `.env.example` carry the var.

Two review rounds changed four of those decisions — the measurement basis, the fetch ordering, the env
var name, and the unset default — so the Design sections below amend `a5e6e7199` rather than only
extending it. They describe the code as it now stands, not work outstanding.

## Scope

In scope, ordered as the issue orders them:

1. A deployment-level cap that drops attachments (keeping the link) rather than letting the send fail.
2. A per-envelope setting controlling whether the completed PDF is attached, defaulting to **true**.
3. Organisation/team-level default for that setting, via the existing `emailDocumentSettings`
   inheritance chain — no new inheritance plumbing.

Items 2 and 3 are close to what #2766 asked for and may get folded into that issue instead. Item 1 does
not depend on either.

Out of scope:

- **The partial-failure behaviour itself.** #3038 (`Promise.all` fan-out) and #3190 (no `io.runTask`
  idempotency) are what turn one rejected send into a total loss. They are separately filed and owned.
  This plan removes the most common trigger; it does not make the handler resilient, and a deployment
  that adopts the cap can still lose every completion email to an unrelated transport error.
- **The MailChannels attachment drop.** `packages/email/transports/mailchannels.ts` builds its payload
  from `subject`, `headers` and a `content` array of text/plain and text/html only — it never reads
  `mail.data.attachments`, confirmed by grep across the whole transports directory. Filed separately as
  a bug. §E leans on this fact for a default but does not fix it.
- Changing the download links, the complete page, or the download dialog.
- Signed/expiring one-off download URLs for non-recipients. Recipients authenticate with their token;
  the owner link is session-authed. A new public URL class is a separate security design.
- The `document.completed` webhook and the v2 download API — unaffected.
- Attaching the certificate or audit log separately. Envelope items only, as today.
- Any other email. The completion handler is the only path that attaches envelope items — the
  `attachments` hits in `packages/api/v1` and `create-document-from-template.ts` are envelope
  attachments, a different feature, not mail attachments.

## Design

### A. Effective cap resolves from the env var, then the transport

The shipped constant reads one env var and nothing else. It gains a transport-aware fallback and a new
name.

**Rename.** `NEXT_PRIVATE_SMTP_MAX_ATTACHMENT_SIZE` → **`NEXT_PRIVATE_EMAIL_MAX_ATTACHMENT_SIZE`**. The
name is wrong today: the handler is transport-agnostic and the cap is enforced before the transport is
consulted, so a Resend deployment reading the SMTP name would reasonably conclude it does not apply to
them. The var is unreleased, so there is no deprecation period and no alias — but the rename must be
complete or it silently stops working. Every reference: `constants/email.ts:16`,
`constants/email.test.ts` (seven `vi.stubEnv` sites), `process-env.d.ts:90`, `.env.example:135`,
`environment.mdx:164`, `email.mdx:46` and `:56`.

**Fallback.** With the var unset, the effective cap comes from the transport:

| Transport | Unset default | Why |
|---|---|---|
| `MAILCHANNELS` | `0` | It provably cannot carry attachments. Fetching PDFs for it is pure waste. |
| `RESEND` | `40_000_000` | Resend's own documented message limit. |
| `SMTP_API` | `null` (no cap) | Depends entirely on the operator's server; guessing is wrong. |
| `SMTP_AUTH` | `null` (no cap) | Same. |

An explicitly set env var wins for every transport, including MailChannels. The two SMTP transports keep
today's behaviour precisely because their limit is unknowable from here — the reporter's own case still
requires configuration, which is the honest trade for not silently stripping attachments from
self-hosters whose server happily carried 20 MB yesterday.

```ts
// packages/lib/constants/email.ts
export const resolveMaxCompletedDocumentAttachmentSize = (
  transportType: TEmailTransportConfig['type'],
): number | null => {
  const configured = MAX_COMPLETED_DOCUMENT_ATTACHMENT_SIZE(); // existing env parse, renamed var

  if (configured !== null) {
    return configured;
  }

  return match(transportType)
    .with('MAILCHANNELS', () => 0)
    .with('RESEND', () => 40_000_000)
    .with('SMTP_API', 'SMTP_AUTH', () => null)
    .exhaustive();
};
```

**This needed plumbing that did not exist.** `getEmailContext` returned `emailTransport: Transporter` —
a built nodemailer object with no discriminator on it. The type lives on the config (`buildTransport`
switches on `config.type`) and, for an organisation's custom transport, on the Prisma `EmailTransport`
row that `resolveEmailTransport` returns as `{ row, transporter }`. `getEmailContext` now returns
`emailTransportType` alongside `emailTransport`, sourced from the resolved row where a custom transport
applies and from the new `mailerTransportType` export in `packages/email/mailer.ts` otherwise. That
export normalises the `NEXT_PRIVATE_SMTP_TRANSPORT` string values (`mailchannels`, `resend`, `smtp-api`,
`smtp-auth`) onto the same union the `EmailTransport` rows use, falling through to `SMTP_AUTH` for
anything unrecognised, which matches the mailer's own default.

Note the consequence: **transport can differ per organisation**, so the effective cap is per-send, not
per-deployment. Anything that caches it at module scope is wrong.

### B. Measurement is the whole rendered message, not just the attachments

`a5e6e7199` compared encoded attachment bytes against the cap. A provider's limit is on the entire
message — MIME headers, boundaries, and both rendered bodies count against it. An admin who reads "OCI
caps at 2 MB" and sets `2000000` still gets the provider's rejection, on exactly the documents this
feature exists to protect. The cap has to be comparable to the number the provider publishes.

Total measured size:

```
encodedAttachmentBytes = Math.ceil(totalRawBytes / 3) * 4
messageBytes           = encodedAttachmentBytes
                       + byteLength(renderedHtml)
                       + byteLength(renderedText)
                       + MIME_OVERHEAD_ALLOWANCE
```

`MIME_OVERHEAD_ALLOWANCE` is `8 * 1024`, covering headers and part boundaries, which are not worth
rendering to measure.

**One decision, from a worst-case render.** The owner email and each recipient email render differently —
different links, different custom bodies — so measuring the real ones would mean deciding inside the
recipient fan-out, producing different emails for different parties to the same envelope. Instead,
`renderCompletedEmailProbeSize` renders one probe email whose every variable field is at least as large
as any real one this envelope will produce, measures it, and the caller applies the single result to
every send.

The shipped probe takes the worst case from the envelope itself rather than from schema maxima, which
is tighter than what this section originally specified:

| Field | Probe value | Why |
|---|---|---|
| `documentName` | `'W'.repeat(DOCUMENT_TITLE_MAX_LENGTH)` | The title is rendered as-is; the bound is imported from `constants/document.ts`, not duplicated |
| `downloadLink` | the longest link any of this envelope's completion emails will carry | Per-recipient token links and the owner's team path differ in length; the longest dominates |
| `customBody` | the longest custom body in play, or `undefined` | Free text with no useful upper bound, so the real values are the only honest measure |
| `reportUrl` | the envelope's report link, if a CC recipient gets one | Present or absent, not variable in length |

A custom body **replaces** the document title line rather than joining it, so when the envelope has one
the probe renders both shapes and takes the larger. Without that, an envelope whose title line is longer
than its custom body would measure short.

**The notice is always included in the probe render.** §D adds a line to the email when an attachment is
dropped, which is part of the body being measured, which is circular — the notice depends on the
decision that depends on the body. Broken by always measuring the with-notice variant
(`wasAttachmentDropped: true`) and omitting the notice at send time when nothing was dropped. The
no-drop case is therefore measured ~200 bytes heavy. That only matters for a message within 200 bytes of
the cap, and erring that way drops an attachment that would just barely have fit rather than sending one
that just barely does not — the error is in the safe direction.

Both the HTML and the plain-text render are measured and summed, since `renderEmailWithI18N` produces
both from the same tree and both go on the wire.

`shouldAttachCompletedDocuments` takes `encodedAttachmentBytes` and `renderedMessageBytes` rather than
`totalRawBytes` alone. It stays pure and unit-tested.
### C. Sizes are probed from storage before anything is downloaded

`a5e6e7199` downloaded every envelope item, summed `content.byteLength`, then asked whether to
attach. The case the cap exists for — an envelope too large for the transport — is also the case where
the full payload is pulled into job-runner memory and discarded. A 50 MB envelope costs 50 MB of
transfer and heap to send a link-only email.

Resolve sizes first, decide, then fetch only if attaching. There is no size to read from the database:
`DocumentData` is `{ id, type, data, initialData, envelopeItem }`, no byte count, and `StorageProvider`
exposes only `getPresignPostUrl`, `getAbsolutePresignPostUrl`, `getPresignGetUrl`, `uploadFile` and
`deleteFile`. Three pieces of new plumbing:

1. **`StorageProvider.getFileSize(key: string): Promise<number>`.** Both backends support it natively —
   `HeadObjectCommand` → `ContentLength` for `S3Provider`, `blockBlobClient.getProperties()` →
   `contentLength` for `AzureBlobProvider`.
2. **`getFileSizeServerSide({ type, data })`** in `get-file.server.ts`, matching on `DocumentDataType`
   the way `getFileServerSide` does. `S3_PATH` → the provider. `BYTES_64` → derived arithmetically from
   the string length, `(data.length / 4) * 3` minus the padding `=` count; decoding to measure would
   reintroduce the exact allocation this section removes. `BYTES` → `TextEncoder().encode(data).length`,
   unavoidable, but the type is legacy and the data is already a string in memory.
3. **Handler** calls it before the fetch.

**The probe only runs when a numeric cap is in effect.** With `cap === null` there is nothing to compare
against and the result cannot change any decision, so the handler goes straight to the existing
fetch-and-attach path. Every deployment on an SMTP transport with the var unset therefore makes zero
additional storage calls and behaves byte-identically to today. The trade is that the probe path is
exercised only where a cap is configured, so its tests carry more weight than usual.

**A failed probe counts as `Infinity`.** A missing object, a transient storage error, or an S3-compatible
endpoint that does not return `ContentLength` means the size is unknown; under a numeric cap that
resolves to link-only, with the warn logged and `totalRawBytes: null`. Failing safe against the
transport error is the point of the feature, and the alternative — falling back to fetch-and-measure —
would keep both code paths alive permanently. The exposure is bounded by the paragraph above: uncapped
deployments never probe, so they cannot acquire this failure mode. It is called out in the docs as the
first thing to check if attachments stop appearing after a cap is set.

### D. The drop is visible in the email that lost it

An `io.logger.warn` was the only trace in `a5e6e7199`, and on a managed install the document owner
cannot read job logs — the observable behaviour was "the completion email stopped having a PDF on it"
with no explanation anywhere in the product.

`TemplateDocumentCompletedProps` gains `wasAttachmentDropped?: boolean`, threaded through
`DocumentCompletedEmailTemplateProps` (already
`Partial<TemplateDocumentCompletedProps> & {...}`, so no signature change) and set by the handler from
the same branch that fires the warn. Rendered under the existing `Continue by downloading the document.`
line:

```tsx
{wasAttachmentDropped && (
  <Text className="my-1 text-center text-muted-foreground text-sm">
    <Trans>This document was too large to attach. Use the download link below to retrieve it.</Trans>
  </Text>
)}
```

Deliberately vague about the cause. The recipient is often external and does not need to know the
sending organisation's provider limits; "too large to attach" is true, actionable and leaks nothing.

The notice does **not** appear when `attachCompletedDocument` is `false` (the sender chose link-only,
nothing was dropped) or when the effective cap is `0` (a configured steady state, and no size was ever
probed, so claiming the document was "too large" would be a lie). Both cases include MailChannels under
its default of `0`, whose recipients see exactly what they see today.

One new translated string, so `npm run translate:extract` is required. `renderEmailWithI18N` produces
both HTML and plain text from the same tree, so there is no separate plain-text copy.

### E. Handler order of operations

The ordering constraints from §A–§D compose into one sequence. Getting it wrong reintroduces the fetch
cost the plan exists to remove, so it is written out explicitly:

1. Resolve `emailSettings`, the transport kind, and the effective cap.
2. If `!attachCompletedDocument` or `cap === 0` or both completion emails are disabled — skip
   everything. No probe, no fetch, no notice.
3. If `cap === null` — skip the probe, fetch and attach as today.
4. Otherwise: render the worst-case probe email (with the notice) and measure its bodies, and probe
   storage for each item's size — the two run concurrently; compute the encoded total; decide.
5. Attach → fetch the PDFs. Drop → `io.logger.warn` with `envelopeId`, `totalRawBytes` and the cap, and
   set `wasAttachmentDropped`.
6. Render the real owner and recipient emails, omitting the notice unless step 5 dropped, and send.

### F. Skipped sends say why in the log

Shipped in `b3baaef45`, after a deployment lost every signing email to a silent skip and the job log
said nothing at all.

Both the signing and completion handlers return early when the envelope owner is disabled or the
organisation has email sending switched off. Neither logged, so the observable behaviour was a job
that reported success and an email that never arrived. Both now `io.logger.warn` with `envelopeId`,
`recipientId`, `organisationId` and the two inputs to the decision.

`send-signing-email.handler.ts` also warns when a recipient address fails
`isRecipientEmailValidForSending`, which skips the send while still writing the `EMAIL_SENT` audit
row — the one case where the audit log on its own is actively misleading.

**Known rough edge, not yet fixed.** The logged `isOwnerDisabled` is `envelope.user.disabled`, the
*envelope* owner, while the `emailsDisabled` it sits next to is
`organisation.owner.disabled || claims.flags.disableEmails` — the *organisation* owner, a different
user, ORed with the claim flag. A reader sees `isOwnerDisabled: false, emailsDisabled: true` and
cannot tell which of the two remaining causes fired. Splitting `getEmailContext` to return them
separately, and logging `isOrganisationOwnerDisabled` and `isDisableEmailsClaimSet`, would make the
line name its own cause.

## Behaviour

| `attachCompletedDocument` | Effective cap | Result for owner and every recipient |
|---|---|---|
| `true` | `null` (unset, SMTP) | PDF attached + link. No probe. |
| `true` | `n > 0`, message under `n` | PDF attached + link |
| `true` | `n > 0`, message over `n` | link only + notice, `warn` logged |
| `true` | `n > 0`, probe failed | link only + notice, `warn` logged with `totalRawBytes: null` |
| `true` | `0` (set, or MailChannels default) | link only, no notice, no probe, no fetch |
| `false` | any | link only, no notice, no probe, no fetch |

A cap of `0` overrides the per-envelope setting — an admin whose transport cannot carry PDFs should not
be overridable by a document-level toggle. That is the only case where the document-level preference is
ignored.

The decision is made once per envelope, so every party to a document gets the same email shape.

Unchanged in every row: subject, template layout, the Download button, the `EMAIL_SENT` audit entries,
and the CC quota metering. A dropped attachment writes no audit-log row — the in-email notice carries
the signal to the person actually affected, without a new audit action type and its migration.

## Files Modified

All shipped. Recorded against what the branch actually changed rather than what was planned.

| File | Change |
|---|---|
| `packages/lib/constants/email.ts` | renamed the env var to `NEXT_PRIVATE_EMAIL_MAX_ATTACHMENT_SIZE`; added `resolveMaxCompletedDocumentAttachmentSize(transportType)` with the per-transport fallback and `MIME_OVERHEAD_ALLOWANCE` |
| `packages/lib/constants/email.test.ts` | renamed across every `vi.stubEnv` site; added the per-transport fallback cases |
| `packages/lib/constants/document.ts` | `DOCUMENT_TITLE_MAX_LENGTH` moved here from the tRPC router so the probe can bound a title without importing that package |
| `packages/email/mailer.ts` | added `mailerTransportType`, normalising `NEXT_PRIVATE_SMTP_TRANSPORT` onto the `TEmailTransportConfig['type']` union; `getTransport` now switches on it |
| `packages/lib/server-only/email/get-email-context.ts` | returns `emailTransportType` alongside `emailTransport`, from the resolved `EmailTransport` row or `mailerTransportType` |
| `packages/lib/universal/upload/providers/storage-provider.ts` | added `getFileSize(key: string): Promise<number>` |
| `packages/lib/universal/upload/providers/s3-provider.ts` | implemented via `HeadObjectCommand` → `ContentLength` |
| `packages/lib/universal/upload/providers/azure-blob-provider.ts` | implemented via `getProperties()` → `contentLength` |
| `packages/lib/universal/upload/server-actions.ts` | exported `getFileSize` off the configured provider |
| `packages/lib/universal/upload/get-file.server.ts` | added `getFileSizeServerSide`; `BYTES_64` derives its size without decoding |
| `packages/lib/utils/email-attachments.ts` | `shouldAttachCompletedDocuments` takes `encodedAttachmentBytes` + `renderedMessageBytes` + `maxMessageBytes`; added `getBase64EncodedSize` and `getUtf8ByteLength` |
| `packages/lib/utils/email-attachments-probe.ts` | **new.** `renderCompletedEmailProbeSize`, the worst-case render described in §B |
| `packages/lib/jobs/definitions/emails/send-document-completed-emails.handler.ts` | the §E sequence; `wasAttachmentDropped` passed to both templates; the §F skip logging |
| `packages/lib/jobs/definitions/emails/send-signing-email.handler.ts` | the §F skip logging |
| `packages/lib/types/document-email.ts` (+ test) | `attachCompletedDocument` on `ZDocumentEmailSettingsSchema` and the `DocumentEmailEvents` enum |
| `packages/email/template-components/template-document-completed.tsx` | `wasAttachmentDropped?: boolean` + the `<Trans>` notice |
| `packages/email/templates/document-completed.tsx` | threads the prop through |
| `packages/trpc/server/document-router/schema.ts` | re-exports `DOCUMENT_TITLE_MAX_LENGTH` from its new home, so existing importers are untouched |
| `packages/lib/server-only/webhooks/trigger/generate-sample-data.ts` | the new settings key in the sample payload |
| `packages/ui/components/document/document-email-checkboxes.tsx` | the checkbox and tooltip, feeding all six surfaces |
| `apps/remix/app/components/general/admin-global-settings-section.tsx` | the setting on the admin surface |
| `packages/tsconfig/process-env.d.ts` | renamed the declared key |
| `.env.example` | renamed; kept the unset / `0` / `n` explanation |
| `packages/lib/translations/*/web.po` | `npm run translate:extract` for the notice string |
| `apps/docs/.../configuration/environment.mdx`, `configuration/email.mdx` | renamed; documented the per-transport defaults and that a failed size probe sends link-only |
| `apps/docs/content/docs/users/organisations/preferences/email.mdx` | documented the new preference. Note this is `email.mdx`, not the `document.mdx` the plan originally named — the setting lives with the other email preferences |
| `packages/app-tests/e2e/...` | `envelope-settings.spec.ts` and `organisation-team-preferences.spec.ts` assert the checkbox |

Deliberately **not** modified — checked, they flow through generically:

- `packages/api/v1/implementation.ts:986-1003` spreads derived settings before overriding
  `documentCompleted`/`ownerDocumentCompleted`, so the new key survives `sendCompletionEmails`.
- All tRPC/embedding/template schemas reference `ZDocumentEmailSettingsSchema` rather than listing keys.
- `document-audit-logs.ts` diffs `emailSettings` as a whole object.
- `duplicate-envelope.ts` and `create-document-from-template.ts` copy the JSON wholesale.
- `packages/lib/universal/upload/get-file.ts` — the deprecated client-side twin, carrying a "DO NOT USE
  OR I WILL FIRE YOU" notice and called by no server path. The probe goes in `get-file.server.ts` only.
## Migration & Compatibility

No Prisma migration. Rows written before this change lack the key; `ZDocumentEmailSettingsSchema.parse`
fills it with `true`, and the schema's `.catch(() => DEFAULT_DOCUMENT_EMAIL_SETTINGS)` already covers
malformed JSON.

**Upgrades are no longer byte-identical for every deployment**, which amends what `a5e6e7199` assumed.
Two transports change without any configuration:

- **MailChannels** gets an implicit cap of `0`. No recipient-visible change — its transport already
  discarded attachments — but the handler stops fetching PDFs that were being thrown away.
- **Resend** gets an implicit 40 MB cap. An envelope over that limit now sends link-only instead of
  failing at the provider. Strictly better, but it is a behaviour change and belongs in the release
  notes.

`SMTP_API` and `SMTP_AUTH` are untouched with the var unset.

The env var rename has no compatibility story because the var is unreleased — it exists only on this
branch, so there is no deployment that could have been configured with the old name by following a
released doc. Field use has already shown the failure mode anyway: an operator reaching for the old
name gets no cap and no warning, just the provider's rejection (see Verification → Field validation).
If this branch does not merge before a release carries the old name, add a fallback read of it for one
minor with a deprecation warn.

A third-party `StorageProvider` implementation, if any exist out of tree, breaks on the new interface
method. Both in-tree providers implement it natively; the interface is not public API.

## Verification

Run on 2026-09-22 against `b3baaef45`:

- `npx vitest run` in `packages/lib` over `constants/email.test.ts`, `utils/email-attachments.test.ts`,
  `types/document-email.test.ts` and `universal/upload/get-file.server.test.ts` — 35 tests, all passing.
- `npx tsc --noEmit` in `packages/lib` — 5 errors, all pre-existing and all in unrelated files
  (`get-completed-fields-for-document.ts`, `get-active-subscriptions-by-user-id.ts`,
  `find-organisation-invoices.ts`). No error in any file this branch touches.
- `grep -rn NEXT_PRIVATE_SMTP_MAX_ATTACHMENT_SIZE` over the tree returns hits in this plan only —
  the rename is complete in code, tests, types, `.env.example` and the docs.

What the automated tests cover:

- **`shouldAttachCompletedDocuments`**: disabled flag; no cap; cap `0` returns `false` even with
  `isAttachmentEnabled: true` and zero bytes; under, exactly at, and over the cap; over via base64
  inflation (20 MB raw against a 25 MB cap must be rejected); rendered body pushing an otherwise-fitting
  payload over; `Infinity` attachment bytes (failed probe) returns `false`.
- **Cap resolution**: env unset → `null` for both SMTP types, `0` for MailChannels, 40 MB for Resend;
  env set → wins for all four, including MailChannels; `''` → treated as unset, not `0`; `'abc'` →
  unset; `'0'` → `0`; `'-100'` → `0`. A `?? 0` regression here silently turns "no cap" into "never
  attach" fleet-wide.
- **`getFileSizeServerSide`**: `BYTES_64` size matches `base64.decode(data).length` for payloads with
  zero, one and two `=` padding characters. The padding arithmetic is the only subtly-wrong-able part,
  and being wrong by two bytes near the boundary is invisible until it isn't.
- **`extractDerivedDocumentEmailSettings`**: key absent from stored JSON → `true`;
  `distributionMethod: NONE` preserves the stored value.

Still manual, and **not yet run**:

1. Toggle on, no cap — attachment present, and no storage HEAD requests are issued.
2. Toggle off — no attachment, no notice; Download resolves to `/sign/{token}/complete` for a
   recipient and the team document page for the owner.
3. Cap `1000` — no attachment, one warn, notice present in both HTML and plain text.
4. Cap `0` with the per-envelope toggle back **on** — no attachment, no warn, no notice. Confirms the
   cap wins and is a steady state rather than an anomaly.
5. Case 3 against a large multi-item envelope — confirm via storage access logs or job timing that no
   PDF was transferred before the decision.
6. A MailChannels transport with the var unset — no fetch, no notice, recipient email unchanged from
   today.
7. The probe render's measured size is greater than or equal to a real render of the same envelope.

E2E coverage already exists for the checkbox surfaces. There is no email-assertion harness in
`packages/app-tests`, so the send path stays manually verified and the pure functions carry the
automated coverage.

### Field validation

A self-hosted deployment on `SMTP_AUTH` against a 2 MB provider limit hit
`552 exceeds byte limit` on a completion email while running this branch, because the operator had
set `NEXT_PRIVATE_SMTP_MAX_ATTACHMENT_SIZE` — the pre-rename name, which nothing reads. The cap
resolved to `null`, the attachment went out at full size and the provider rejected the message.

Two things this confirms. The rename is right on the merits and wrong on the ergonomics: the old name
was the one an operator reached for, and an unrecognised `NEXT_PRIVATE_*_MAX_ATTACHMENT_SIZE` is
indistinguishable from an unset one at runtime. Worth considering a startup warn on the old key, or
naming it in the send-failure path. And the `SMTP_AUTH` default of `null` means the transport this
feature was filed for still fails by default until it is configured — the honest trade documented in
§A, now observed rather than predicted.
## Open Questions

All four are closed. Kept with their resolutions because the reasoning behind a default that
silently strips attachments is worth being able to re-read.

1. **`MIME_OVERHEAD_ALLOWANCE` value.** Resolved: `8 * 1024`, in `packages/lib/constants/email.ts`,
   documented there as a safety margin rather than a measurement.
2. **Resend's 40 MB figure.** Resolved: shipped as the `RESEND` default. It is Resend's documented
   whole-message limit, base64-encoded attachments included. Re-confirm it if Resend restates the
   limit — a wrong default here fails silently.
3. **Does `getFileSize` belong on `StorageProvider`?** Resolved: on the interface. Both in-tree
   backends implement it natively (`HeadObjectCommand` → `ContentLength`,
   `getProperties()` → `contentLength`), and the alternative duplicated the backend switch.
4. **Scope items 2 and 3 here or on #2766?** Still the maintainer's call, and it does not block
   anything — all three items are built. #2766 remains open, `Stale`, `status: review needed`.

Resolved in earlier review: the field name (`attachCompletedDocument`, already shipped — changing it
now costs a JSON migration); the cap being total across items rather than per item; all-or-nothing
rather than attaching the subset that fits; and `0` as a hard override rather than a default.
