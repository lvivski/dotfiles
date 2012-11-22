#!/bin/bash
cd "$(dirname "$0")"
git pull
function push() {
	rsync --exclude ".git/" --exclude ".DS_Store" --exclude "sync.sh" --exclude "README.md" -av . ~
}
function pull() {
	find . -type f \( ! -path "*.git/*" ! -name ".DS_Store" ! -name "README.md" ! -name "sync.sh" \) -exec cp ~/{} {} \;
}
if [ "$1" == "--pull" -o "$1" == "-p" ]; then
	pull
elif [ "$1" == "--force" -o "$1" == "-f" ]; then
	push
else
	read -p "This may overwrite existing files in your home directory. Are you sure? (y/n) " -n 1
	echo
	if [[ $REPLY =~ ^[Yy]$ ]]; then
		push
	fi
fi
unset push
unset pull
source ~/.bash_profile
