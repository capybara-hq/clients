---
"@capybara-hq/mobile": patch
---

iOS: removing a platform deletes its data store for good. A store written back to disk by its
closing session right after the removal stays scheduled and is removed again, instead of being
counted as gone while its cookies stay behind.
