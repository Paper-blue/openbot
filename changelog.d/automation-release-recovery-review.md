### Fixed

- A second run of the personal release completes. It continues the draft release of the same tag, loads only
  the artifacts that the release does not have yet, and publishes the release after it compares every artifact
  with its SHA-256 digest. Before, the second run stopped at the draft release that the first run made.
