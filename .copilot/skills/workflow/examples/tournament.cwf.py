options = args or [
    "Use a flat JSON config file.",
    "Use a typed Python configuration module.",
    "Use environment variables only.",
]

winner = wf.tournament(
    options,
    criteria="clearest API design, lowest maintenance risk, and easiest migration path",
    label="judge",
)

print(winner)
