# RC
[[ -f ~/.bashrc ]] && . ~/.bashrc

# Prompt
[[ -f ~/.bash_prompt ]] && . ~/.bash_prompt

# Aliases
[[ -f ~/.bash_aliases ]] && . ~/.bash_aliases

# Homebrew
[[ -f /usr/local/etc/bash_completion ]] && . /usr/local/etc/bash_completion

# Node
[[ -d  ~/.node-completion ]] && for file in ~/.node-completion/*
do
    . $file
done && unset file
