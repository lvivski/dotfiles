# RC
[[ -f ~/.bashrc ]] && . ~/.bashrc

# Aliases
[[ -f ~/.bash_aliases ]] && . ~/.bash_aliases

# Aliases
[[ -f ~/.bash_prompt ]] && . ~/.bash_prompt

# Homebrew
[[ -f /usr/local/etc/bash_completion ]] && . /usr/local/etc/bash_completion

# Node
[[ -d  ~/.node-completion ]] && for file in ~/.node-completion/*
do
    . $file
done && unset file
