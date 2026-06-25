# RC
[[ -f ~/.bashrc ]] && . ~/.bashrc

# Exports
[[ -f ~/.exports ]] && . ~/.exports

# Prompt
[[ -f ~/.prompt ]] && . ~/.prompt

# Aliases
[[ -f ~/.aliases ]] && . ~/.aliases

# Functions
[[ -f ~/.functions ]] && . ~/.functions

# Homebrew bash completion (covers @1 and @2)
[[ -f $HOMEBREW_PREFIX/etc/profile.d/bash_completion.sh ]] && . $HOMEBREW_PREFIX/etc/profile.d/bash_completion.sh

#Rust
[[ -f ~/.cargo/env ]] && . ~/.cargo/env
