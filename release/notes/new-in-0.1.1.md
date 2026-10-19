## New in 0.1.1

A quick fix to setting SYNQ Helper up from the website, a few hours after 0.1.0. Everything new in 0.1.0 is in
`CHANGELOG.md`.

- **Setting up SYNQ Helper from the website asks less.** Opening the synq-helper.exe you got from synqhub.app now
  counts as your yes for the site: for ten minutes after, the website connects without SYNQ Helper asking "allow this
  site?" again. A new pairing after that, or from any other site, is still asked about.
- **The website finds SYNQ Helper sooner and doesn't give up early.** It looks every second instead of every three,
  "Already have it? Connect" waits for the helper instead of saying it isn't running, and the steps follow the order
  Chrome and Windows ask in (Download, Allow, Open it), each lit when done, with a line saying what to do now.
- **The website links to SYNQ's Discord.**
