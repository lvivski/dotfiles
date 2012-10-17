# Colourful listing
if [ "$TERM" != "dumb" ]; then
    alias ls='ls -GF'
    alias ll='ls -l'
fi
alias la='ls -lAohF'

# Get process PID
alias ps?='ps waux |grep'

# Easy navigation
alias ..='cd ..;'
alias ...='.. ..'
alias ~='cd ~'
alias -- -='cd -'

# Shortcuts
alias vim='/Applications/MacVim.app/Contents/MacOS/Vim'
alias mvim='/Applications/MacVim.app/Contents/MacOS/Vim -g'
alias subl='/Applications/Sublime\ Text\ 2.app/Contents/SharedSupport/bin/subl'

alias d='cd ~/Dropbox'
alias p='cd ~/Projects'
alias g='git'
alias v='vim'
alias e='vim'
alias s='subl'

alias cp='cp -i'
alias mv='mv -i'
alias rm='rm -i'
alias rmr='rm -r'
alias cleanup="find . -type f -name '*.DS_Store' -ls -delete"

alias mkdir='mkdir -p'

# Enhanced WHOIS lookups
alias whois="whois -h whois-servers.net"

# OS X has no `md5sum`, so use `md5` as a fallback
command -v md5sum > /dev/null || alias md5sum="md5"

# OS X has no `sha1sum`, so use `shasum` as a fallback
command -v sha1sum > /dev/null || alias sha1sum="shasum"

# Copy public key to clipboard
function pubkey() {
	more ~/.ssh/id_rsa$@.pub | pbcopy | echo '=> Public key copied to clipboard.';
}

# Create a new directory and enter it
function mkd() {
	mkdir -p "$@" && cd "$@"
}

# Determine size of a file or total size of a directory
function fs() {
	if du -b /dev/null > /dev/null 2>&1; then
		local arg=-sbh
	else
		local arg=-sh
	fi
	if [[ -n "$@" ]]; then
		du $arg -- "$@"
	else
		du $arg .[^.]* *
	fi
}

# Create a data URL from an image (works for other file types too, if you tweak the Content-Type afterwards)
function dataurl() {
	local mimeType=$(file -b --mime-type "$1")
	[[ $mimeType == text/* ]] && mimeType="${mimeType};charset=utf-8"
	echo "data:${mimeType};base64,$(openssl base64 -in "$1" | tr -d '\n')"
}

# Start an HTTP server from a directory, optionally specifying the port
function server() {
	local port="${1:-8000}"
	sleep 1 && open "http://localhost:${port}/" &
	# Set the default Content-Type to `text/plain` instead of `application/octet-stream`
	# And serve everything as UTF-8 (although not technically correct, this doesn’t break anything for binary files)
	python -c $'import SimpleHTTPServer;\nmap = SimpleHTTPServer.SimpleHTTPRequestHandler.extensions_map;\nmap[""] = "text/plain";\nfor key, value in map.items():\n\tmap[key] = value + ";charset=UTF-8";\nSimpleHTTPServer.test();' "$port"
}

# Get gzipped file size
function gz() {
	echo "orig size (bytes): "
	cat "$1" | wc -c
	echo "gzipped size (bytes): "
	gzip -c "$1" | wc -c
}

# Syntax-highlight JSON strings or files
# Usage: `json '{"foo":42}'` or `echo '{"foo":42}' | json`
function json() {
	if [ -t 0 ]; then # argument
		python -mjson.tool <<< "$*" | pygmentize -l javascript
	else # pipe
		python -mjson.tool | pygmentize -l javascript
	fi
}

# Escape UTF-8 characters into their 3-byte format
function escape() {
	printf "\\\x%s" $(printf "$@" | xxd -p -c1 -u)
	echo # newline
}

# Decode \x{ABCD}-style Unicode escape sequences
function unidecode() {
	perl -e "binmode(STDOUT, ':utf8'); print \"$@\""
	echo # newline
}

# Get a character’s Unicode code point
function codepoint() {
	perl -e "use utf8; print sprintf('U+%04X', ord(\"$@\"))"
	echo # newline
}

# Take current repo and copy it to somewhere else minus the .git stuff.
function gitexport() {
	mkdir -p "$1"
	git archive master | tar -x -C "$1"
}

# Open man pages as nicely-formatted PostScript in OS X Preview
function pman() {
	man -t "$@" | open -f -a Preview;
}
