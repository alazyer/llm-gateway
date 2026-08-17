## ADDED Requirements

### Requirement: The web chat composer SHALL capture, validate, and preview image attachments

The web chat composer SHALL accept image file selection (one or more) when the active model supports image input, SHALL validate each selection by MIME type and size, SHALL preview each accepted attachment as a removable chip with a thumbnail, and SHALL clear attachments after a successful send.

#### Scenario: Valid image is attached and previewed
- **WHEN** a user selects an `image/png` file within the per-image size cap (~700 KB base64) while a model supporting image input is active
- **THEN** the composer SHALL render a removable preview chip with a thumbnail of the image
- **AND** SHALL NOT submit the attachment until the user sends

#### Scenario: Oversized image is rejected client-side
- **WHEN** a user selects an image exceeding the per-image size cap (~700 KB base64)
- **THEN** the composer SHALL reject the selection
- **AND** SHALL surface an inline message stating the size limit
- **AND** SHALL NOT attach the file

#### Scenario: Non-image file is rejected
- **WHEN** a user selects a file whose MIME type is not an image type
- **THEN** the composer SHALL reject the selection with an inline message
- **AND** SHALL NOT attach the file

#### Scenario: Single-image limit enforced
- **WHEN** a user already has one image attached and attempts to attach another
- **THEN** the composer SHALL reject the additional selection with an inline message stating that only one image per message is supported
- **AND** SHALL retain the already-attached image

#### Scenario: Attachment removed before send
- **WHEN** a user removes a previewed attachment chip
- **THEN** the composer SHALL drop that attachment from the pending set
- **AND** SHALL NOT include it in the next send

#### Scenario: Attachments cleared after successful send
- **WHEN** a multimodal message send completes successfully
- **THEN** the composer SHALL clear all pending attachments
- **AND** SHALL clear the text prompt

### Requirement: The web chat composer SHALL gate image attachment on model capability

The composer SHALL disable image attachment and SHALL surface a hint when the active model does not support image input, so users cannot compose a multimodal message the backend will reject.

#### Scenario: Attachment control disabled for non-image model
- **WHEN** the active model's discovered `input_modalities` does not include `image`
- **THEN** the composer SHALL disable the attachment control
- **AND** SHALL show a hint that the selected model does not support image input

#### Scenario: Attachment control enabled for image-capable model
- **WHEN** the active model's discovered `input_modalities` includes `image`
- **THEN** the composer SHALL enable the attachment control

#### Scenario: Pending image retained and Send blocked after a switch to a non-image model
- **GIVEN** a pending (unsent) image is in the composer while a vision model is active
- **WHEN** the user switches the model picker to a model whose `input_modalities` does not include `image`
- **THEN** the composer SHALL disable the attachment control
- **AND** SHALL retain the pending image (not auto-discard it)
- **AND** SHALL block the Send action specifically because an unsupported attachment is present
- **AND** SHALL show a blocking hint offering to remove the attachment or switch the model back
- **AND** SHALL re-enable Send for a text-only message once the attachment is removed

### Requirement: The web chat timeline SHALL render restored image attachments from history

When a session's persisted user messages include image attachments, the timeline SHALL render the text prompt and each image attachment alongside it on session open and on history reload.

#### Scenario: Image attachments restore on session open
- **GIVEN** a session has a prior user message with text and a stored image attachment
- **WHEN** the user opens the session
- **THEN** the timeline SHALL render the message's text
- **AND** SHALL render the stored image as a thumbnail preview
- **AND** SHALL NOT require a separate fetch to load the images

### Requirement: The web client SHALL send attachments in the production chat request payload

The web client SHALL include an `attachments` array of `{ id, type, dataUrl }` image parts (base64 data URLs) in `POST /api/ai-chat/messages` for both stream and non-stream modes when attachments are present, alongside the required text `prompt`.

#### Scenario: Stream message carries attachments
- **WHEN** a user sends a message with a non-empty `prompt` and one attachment while a stream is active
- **THEN** the request body SHALL include `stream: true`, `prompt`, and an `attachments` array containing the attachment's `id`, `type`, and base64 `dataUrl`

#### Scenario: Text-only message omits attachments
- **WHEN** a user sends a message with no attachments
- **THEN** the request body SHALL omit the `attachments` field (or send an empty array) and SHALL include only `prompt`
