# RC
[[ -f ~/.bashrc ]] && . ~/.bashrc

# Exports
[[ -f ~/.bash_exports ]] && ./.bash_exports

# Prompt
[[ -f ~/.bash_prompt ]] && . ~/.bash_prompt

# Aliases
[[ -f ~/.bash_aliases ]] && . ~/.bash_aliases

# Functions
[[ -f ~/.bash_functions ]] && . ~/.bash_functions

# Homebrew
[[ -f /usr/local/etc/bash_completion ]] && . /usr/local/etc/bash_completion

# Iterm
[[ -f ~/.iterm2_shell_integration.bash && $TERM_PROGRAM == "iTerm.app" ]] && . ~/.iterm2_shell_integration.bash
