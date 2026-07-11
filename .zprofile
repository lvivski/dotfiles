# Exports (also sets HOMEBREW_PREFIX)
[[ -f ~/.exports ]] && . ~/.exports

# Homebrew zsh completions
[[ -n $HOMEBREW_PREFIX && -d $HOMEBREW_PREFIX/share/zsh/site-functions ]] && FPATH=$HOMEBREW_PREFIX/share/zsh/site-functions:$FPATH

# Prompt
[[ -f ~/.prompt ]] && . ~/.prompt

# Aliases
[[ -f ~/.aliases ]] && . ~/.aliases

# Functions
[[ -f ~/.functions ]] && . ~/.functions

#Rust
[[ -f ~/.cargo/env ]] && . ~/.cargo/env
