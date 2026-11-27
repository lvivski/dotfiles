# Historical reader fixtures

`legacy-readers.tar.xz` is a source archive, not a run snapshot. Each member is
`VERSION/work/{reader.version,*.mjs,rules/*.mjs}`. There are **no** ledgers, outcome keys,
Git objects, persisted sessions, user files, or historical tests. The common
test host creates fresh synthetic Git repositories and executes the archived
framework's original evaluator processes. The recovery reader then opens that
same repository. Extracting the archive needs `tar` with xz support, not Python,
network access or repository history. Only the archive-building control requires Python 3.

| Reader | Source | Used to reproduce |
| --- | --- | --- |
| 22 | `bbc52fbb66` | Pre-journal component exit followed by a missing-input stop; no runner signing key |
| 51 | pre-release; manifest `d3fdc93c746e3a06bc7cfc653dc4d1debc8ea200e9124385a4da9085647e39c3` | Transfer rejected on the checked parent's original grant |
| 52 | pre-release; manifest `189eb34e1ecb18bb0e7cff4b648025977051fc551b423eb636bab70e6f808838` | Mixed grant displacement, rejected successors and stopped-writer correction |
| 54 | pre-release; manifest `58f3ad9077fc628b93428032941dd0a96c1b38c1387198de510ed2c2bc210fd5` | Citation prevents restoration |
| 55 | `60e7374379` | Signed failed attestation |
| 56 | `e72082ebda` | Negative pair without observer repair |
| 58 | `51bf1c76d2` | Failed observer without an independent checkpoint |
| 59 | `787747a567` | First signed observer failure without a replacement |
| 60 | `11aad35764` | Final signed diagnostic failure without a production repair |
| 61 | pre-release; manifest `5d0f135efc0a37cab7dbf7abae5c3cc3d15c8fdc915f0eadb9c7396fdb214210` | Withdrawn production grant while an unrelated stopped assignment needs a narrow successor |
| 64 | pre-release; manifest `97c58bcbab1a77648b7e40cc7c881d1f15c649142d8ac00961e6fa19fa0d12a9` | A disjoint product update overtakes an approved source comparison before its report returns |
| 79 | pre-release; manifest `a8b4a8b9324d258b85c0643fe5b717afc31e7402f934af581db128e90d36bd17` | An adopted assembly's component fails on an inherited caller; a published correction never reaches the product |
| 80 | `b29fdd2669`; manifest `4ce6d6f81f943134fbcad2ded468dcd3cef45883094be353086d85c5452ce4b4` | A reloaded owner remains stuck at `presenting` after the original approval callback disappears |
| 81 | installed revision with prepared components; manifest `51610e29325b96f6ab47d996d93eebeecfc1cb497e4f7c5793c70b468c06ac85` | A verified restoration with no assigning scout cannot correct its owned file after adoption |
| 89 | pre-release; manifest `7f0f48172ea73bd18d8546e8c09029f59755ad1bd9fba5757e247b84c1bc6549` | A signed failure cannot repair a defective evaluator; outstanding desktop reservations and historical observer evidence |
| 90 | pre-release; manifest `2f37253886b1ffa99794c41d84077e52904e07f0bcea57ce07a28a059e01aa05` | Unobserved tests, unpublished full-index corrections, dependent scope refusals and a superseded claimed goal |
| 91 | pre-release; manifest `9cf133613434c3a055fb909b5ddf9a54b54273bfe5f3155bf4ab47307a820708` | An original writer remains stopped after the owner offers the exact missing reference; no preview, baseline or verdict exists |
| 94 | installed edition; manifest `76cc1bb5f7002082022fb762d3790bd61bba0787f7cd185291ea73f15a18b736` | Linked but unnotified writers, owner-only artifact provenance and recovery on the same stopped assignments |
| 95 | frozen writer-first edition; manifest `5451c7b4a1276cc236120feec04cb8a6f334a964d706fdfe8aba588121caef06` | An unrelated read-only reference invalidates consent to an otherwise unchanged correction on a failed assembly |

Inspect with `tar -tf legacy-readers.tar.xz` or
`tar -xOf legacy-readers.tar.xz 59/work/observer.mjs`.
Pre-release manifest IDs are SHA-256 of the concatenated `SHA256  filename\n`
lines for the archived files, sorted by path relative to `work/` (for example, `rules/activity.mjs`). They identify exact source
bytes, not references that must exist in a checkout.

To repack, extract the archive into a scratch directory. Add any new
versioned extension source there (do not change an existing version).
Run `python3 pack-readers.py OUTPUT.tar.xz SCRATCH/*` and update the table.
The packer reads only the version, top-level runtime modules and executable rules and omits
tests, types, timestamps and filesystem metadata.
