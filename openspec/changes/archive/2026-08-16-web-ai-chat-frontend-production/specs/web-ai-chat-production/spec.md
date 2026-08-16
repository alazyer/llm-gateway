## MODIFIED Requirements

### Requirement: Production flow SHALL replace quick-validation mode

The previous quick-validation-only flow SHALL be removed or redirected so only production chat flow remains active, including in the web client.

#### Scenario: Legacy validation entry path behavior
- **WHEN** user navigates to legacy quick-validation entry
- **THEN** navigation SHALL resolve to production chat capability
- **AND** no separate quick-validation operational mode SHALL remain

#### Scenario: Web client resolves legacy validation mode to production chat
- **WHEN** a user enters the web chat surface that previously ran quick-validation mode
- **THEN** the web client SHALL present the production chat experience backed by `/api/ai-chat/*`
- **AND** SHALL NOT expose a separate quick-validation operational mode or toggle
