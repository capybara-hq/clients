---
"@capybara-hq/desktop": patch
---

Removing a platform closes its windows for good: a page's leave prompt cannot keep one open, and
nothing (a notification clicked later, a sign-in finishing, a menu click while its data is
cleared) opens a window on the removed platform again. Closing the last window by a removal on
Windows and Linux quits only once the platform's data is cleared.
