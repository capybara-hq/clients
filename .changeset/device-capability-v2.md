---
"@capybara-hq/desktop": minor
"@capybara-hq/shell": minor
---

The desktop offers `device@2`: a deployment window sees and acts on only this computer's
connections into its own deployment, and every call names a connection by its device id (calls
naming another deployment's device are refused). Connecting adds a connection and leaves the others
as they are; removing a platform asks once and logs out each of its connections. Every device
command names its connection (`-c`), and the owner ceiling's project reach is
`workspace`, `paths` or `machine`.
