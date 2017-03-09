# Case-insensitive globbing (used in pathname expansion)
shopt -s nocaseglob

# Append to the Bash history file, rather than overwriting it
shopt -s histappend

# Autocorrect typos in path names when using `cd`
shopt -s cdspell

export CLICOLOR=true

# Enable grep coloring unless command is piped.
export GREP_OPTIONS='--color=auto'

# Ignore duplicates in history.
export HISTCONTROL=ignoreboth:erasedups
export HISTIGNORE="&:l[ls]:ls *:cd *:[bf]g:exit:kill *:* --help:date:pwd:cd"
export HISTSIZE=1000

export EDITOR=vim
export VISUAL=$EDITOR
export PAGER=less
export MANPAGER='less -X'

# R - Raw color codes in output (don't remove color codes)
# e - quit on second eof
# S - Don't wrap lines, just cut off too long text
# ~ - Don't show those weird ~ symbols on lines after EOF
# g - Highlight results when searching with slash key (/)
# I - Case insensitive search
# s - Squeeze empty lines to one
# w - Highlight first line after PgDn
export LESS='-RI~egsw'

[[ -d /usr/local/bin ]] && export PATH=/usr/local/bin:$PATH

[[ -d ~/.cabal/bin ]] && export PATH=~/.cabal/bin:$PATH

export PATH=./node_modules/.bin:$PATH

launchctl setenv PATH $PATH

export GEM_HOME=/usr/local/share/ruby
export NVM_DIR=~/.nvm

export LS_COLORS='no=00:fi=00:di=01;34:ln=01;36:pi=40;33:so=01;35:do=01;35:bd=40;33;01:cd=40;33;01:or=40;31;01:ex=01;32:*.tar=01;31:*.tgz=01;31:*.arj=01;31:*.taz=01;31:*.lzh=01;31:*.zip=01;31:*.z=01;31:*.Z=01;31:*.gz=01;31:*.bz2=01;31:*.deb=01;31:*.rpm=01;31:*.jar=01;31:*.jpg=01;35:*.jpeg=01;35:*.gif=01;35:*.bmp=01;35:*.pbm=01;35:*.pgm=01;35:*.ppm=01;35:*.tga=01;35:*.xbm=01;35:*.xpm=01;35:*.tif=01;35:*.tiff=01;35:*.png=01;35:*.mov=01;35:*.mpg=01;35:*.mpeg=01;35:*.avi=01;35:*.fli=01;35:*.gl=01;35:*.dl=01;35:*.xcf=01;35:*.xwd=01;35:*.ogg=01;35:*.mp3=01;35:*.wav=01;35:'
export LSCOLORS=exfxcxdxbxegedabagacad
