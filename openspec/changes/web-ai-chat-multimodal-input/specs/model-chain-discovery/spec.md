## ADDED Requirements

### Requirement: Model discovery SHALL advertise truthful input modalities per model

The `capabilities.input_modalities` field on model discovery records SHALL reflect whether each model supports image input, derived from the model's configured `supports_image_input` capability, instead of a hard-coded text-only value.

#### Scenario: Image-capable model advertises text and image
- **WHEN** a configured static model has `supports_image_input: true`
- **THEN** its `GET /v1/models` record SHALL have `capabilities.input_modalities` containing both `text` and `image`

#### Scenario: Text-only model advertises text only
- **WHEN** a configured static model has `supports_image_input: false` (the default)
- **THEN** its `GET /v1/models` record SHALL have `capabilities.input_modalities` equal to `["text"]`

#### Scenario: Chain advertises image input only when all members support it
- **GIVEN** a chain with member models
- **WHEN** every member model has `supports_image_input: true`
- **THEN** the chain's virtual model record SHALL have `capabilities.input_modalities` containing both `text` and `image`
- **AND** when any member model has `supports_image_input: false`, the chain SHALL advertise `["text"]` only

### Requirement: Model configuration SHALL declare image-input support per model

The model catalog SHALL allow operators to declare whether a model supports image input via a `supports_image_input` flag, persisted alongside the existing `supports_tools` and `supports_streaming` capability flags and manageable through the admin model API.

#### Scenario: Model created with image input support
- **WHEN** an operator creates or updates a model with `supports_image_input: true`
- **THEN** the flag SHALL be persisted and reflected in subsequent model discovery

#### Scenario: Existing models default to text-only
- **WHEN** the database is migrated to add the `supports_image_input` column
- **THEN** all pre-existing models SHALL default to `supports_image_input: false`
- **AND** SHALL continue to advertise `["text"]` input modalities until an operator enables image input
