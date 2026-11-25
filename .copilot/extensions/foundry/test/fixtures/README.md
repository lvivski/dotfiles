# Historical reader fixtures

`legacy-readers.tar.xz` is a source archive, not a run snapshot. Each member is
`VERSION/work/{reader.version,*.mjs}`. There are **no** ledgers, outcome keys,
Git objects, persisted sessions, user files, or historical tests. The common
test host creates fresh synthetic Git repositories and executes the archived
framework's original evaluator processes. The recovery reader then opens that
same repository. Extracting the archive needs `tar` with xz support; Node runs
the tests without Python, network access or repository history.

| Reader | Source | Used to reproduce |
| --- | --- | --- |
| 51 | pre-release; manifest `d3fdc93c746e3a06bc7cfc653dc4d1debc8ea200e9124385a4da9085647e39c3` | Transfer rejected on the checked parent's original grant |
| 52 | pre-release; manifest `189eb34e1ecb18bb0e7cff4b648025977051fc551b423eb636bab70e6f808838` | Mixed grant displacement, rejected successors and stopped-writer correction |
| 54 | pre-release; manifest `58f3ad9077fc628b93428032941dd0a96c1b38c1387198de510ed2c2bc210fd5` | Citation prevents restoration |
| 55 | `60e7374379` | Signed failed attestation |
| 56 | `e72082ebda` | Negative pair without observer repair |
| 58 | `51bf1c76d2` | Failed observer without an independent checkpoint |
| 59 | `787747a567` | First signed observer failure without a replacement |
| 60 | `11aad35764` | Final signed diagnostic failure without a production repair |
| 61 | pre-release; manifest `5d0f135efc0a37cab7dbf7abae5c3cc3d15c8fdc915f0eadb9c7396fdb214210` | Withdrawn production grant while an unrelated stopped assignment needs a narrow successor |

Inspect with `tar -tf legacy-readers.tar.xz` or
`tar -xOf legacy-readers.tar.xz 59/work/observer.mjs`.
Pre-release manifest IDs are SHA-256 of the concatenated `SHA256  filename\n`
lines for the archived files, sorted by filename. They identify exact source
bytes, not references that must exist in a checkout.

To repack, extract the archive into a scratch directory. Add any new
versioned extension source there (do not change an existing version).
Run `python3 pack-readers.py OUTPUT.tar.xz SCRATCH/*` and update the table.
The packer reads only the version and top-level runtime modules and omits
tests, types, timestamps and filesystem metadata.
