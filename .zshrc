autoload -U compinit && compinit

WORDCHARS=''

# Case-insensitive globbing (used in pathname expansion)
unsetopt menu_complete   # do not autoselect the first completion entry
unsetopt flowcontrol
setopt auto_menu         # show completion menu on successive tab press
setopt complete_in_word
setopt always_to_end

zstyle ':completion:*:*:*:*:*' menu select
zstyle ':completion:*' matcher-list 'm:{a-zA-Z-_}={A-Za-z_-}' 'r:|=*' 'l:|=* r:|=*'
zstyle ':completion:*' special-dirs true
zstyle ':completion:*' list-colors ''
zstyle ':completion:*:cd:*' tag-order local-directories directory-stack path-directories

export EDITOR=vim
export VISUAL=$EDITOR
export PAGER=less
export MANPAGER='less -X'

[[ -d /usr/local/sbin ]] && export PATH=/usr/local/sbin:$PATH

[[ -d /usr/local/bin ]] && export PATH=/usr/local/bin:$PATH

[[ -d /usr/local/opt/flutter/bin ]] && export PATH=/usr/local/opt/flutter/bin:$PATH

[[ -d ~/.cabal/bin ]] && export PATH=~/.cabal/bin:$PATH

export PATH=./node_modules/.bin:$PATH

launchctl setenv PATH "$PATH"

export GEM_HOME=/usr/local/share/ruby
