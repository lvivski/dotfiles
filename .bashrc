# Case-insensitive globbing (used in pathname expansion)
shopt -s nocaseglob

# Append to the Bash history file, rather than overwriting it
shopt -s histappend

# Autocorrect typos in path names when using `cd`
shopt -s cdspell

# Enable grep coloring unless command is piped.
export GREP_OPTIONS='--color=auto'

# Ignore duplicates in history.
export HISTCONTROL=ignoreboth
export HISTIGNORE="&:l[ls]:ls *:cd *:[bf]g:exit:kill *:* --help:date:pwd:cd"

export EDITOR=vim

export PATH=/usr/local/bin:$PATH
