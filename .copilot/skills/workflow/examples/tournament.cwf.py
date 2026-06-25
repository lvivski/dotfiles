options = args or [
    "Use a flat JSON config file.",
    "Use a typed Python configuration module.",
    "Use environment variables only.",
]

winner = wf.tournament(
    options,
    criteria="clearest API design, lowest maintenance risk, and easiest migration path",
    model="claude-sonnet-4.5",
    label="judge",
)

print(winner)
