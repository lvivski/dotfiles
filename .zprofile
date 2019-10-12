# Homebrew
[[ -f /usr/local/share/zsh/site-functions ]] && FPATH=/usr/local/share/zsh/site-functions:$FPATH

# RC
[[ -f ~/.zshrc ]] && . ~/.zshrc

# Prompt
: ${on:=%{$'\e[0;37m'%}}
: ${off:=%{$'\e[1;30m'%}}
: ${red:=%{$'\e[0;31m'%}}
: ${green:=%{$'\e[0;32m'%}}
: ${yellow:=%{$'\e[0;33m'%}}
: ${violet:=%{$'\e[0;35m'%}}
: ${branch_color:=%{$'\e[0;34m'%}}
#: ${blinking:=%{$'\e[1;5;17m'%}}
: ${reset:=%{$'\e[0m'%}}
[[ -f ~/.bash_prompt ]] && . ~/.bash_prompt

# Aliases
[[ -f ~/.bash_aliases ]] && . ~/.bash_aliases

# Functions
[[ -f ~/.bash_functions ]] && . ~/.bash_functions
