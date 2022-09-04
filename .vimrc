" General
set nocompatible
filetype off
set backspace=indent,eol,start

set ttyfast
set lazyredraw

set number relativenumber
set encoding=utf-8
set fileencodings=utf-8,cp1251
set fileformat=unix
set ttimeoutlen=250
"set colorcolumn=80
"set textwidth=80

set mouseshape=s:udsizing,m:no
set mousehide
set mouse=a

set title
"set scrolloff=999 " Focus mode
set formatoptions+=o " Automatically insert the current comment leader after hitting 'o' or 'O' in Normal mode.
set formatoptions-=r " Do not automatically insert a comment leader after an enter
set formatoptions-=t " Do no auto-wrap text using textwidth (does not apply to comments)

set clipboard=unnamed " system clipboard

" Autocomplete
set wildmenu
set wildmode=list:longest,full
set wildignore+=.hg,.git,.svn                    " Version control
set wildignore+=*.aux,*.out,*.toc                " LaTeX intermediate files
set wildignore+=*.jpg,*.bmp,*.gif,*.png,*.jpeg   " binary images
set wildignore+=*.luac                           " Lua byte code
set wildignore+=*.o,*.obj,*.exe,*.dll,*.manifest " compiled object files
set wildignore+=*.pyc                            " Python byte code
set wildignore+=*.spl                            " compiled spelling word lists
set wildignore+=*.sw?                            " Vim swap files
set wildignore+=*.DS_Store,Icon?                 " OSX bullshit
set wildignore+=*.orig                           " Merge resolution files
set wildignore+=.vagrant                         " Vagrant dotfile
set wildignore+=node_modules                     " npm folder

" Search
set hlsearch
set incsearch
set ignorecase
set smartcase
set gdefault

let loaded_matchparen=1
set noshowmatch
set matchpairs+=<:>

" Tabstops are 4 spaces
set tabstop=4
set shiftwidth=4
set softtabstop=4
set expandtab
set autoindent
set copyindent
set smartindent
set shiftround
set visualbell

" Splits
set splitbelow
set splitright

" File read
set hidden
set autoread
set autowrite

" Use modern backup techniques
set nobackup
set noswapfile

set list
set wrap
set listchars=tab:▸\ ,trail:·,extends:❯,precedes:❮,nbsp:×
set linebreak
let &sbr = nr2char(8618).' '
set dictionary=/usr/share/dict/words
if has('mac')
  set guifont=Menlo\ Regular:h13
else
  set guifont=Liberation\ Mono\ 13
end

" Cursor not blink
set cursorline

set shortmess+=asIT " No intro screen
"set cmdheight=2 " No `Hit Enter to continue`

" Lastline
set showcmd
set showmode

set ruler
set rulerformat=%40(%=\:b%n\ %y%m\ %11(%c,%l/%L%)%)
set statusline=%{expand('%:p:~')}\ %=\:b%n\ %y%m\ %11(%c,%l/%L%)\

" Remap curyllic
set langmap=йцукенгшщзхїґфивапролджєячсмітьбюЙЦУКЕНГШЩЗХЇҐФИВАПРОЛДЖЄЯЧСМІТЬБЮ;qwertyuiop[]\\\\asdfghjkl\\;'zxcvbnm\\,.QWERTYUIOP{}\\|ASDFGHJKL:\\"ZXCVBNM\\<\\>

" MAPPINGS

let mapleader = ","

" Toogle past mode
set pastetoggle=<Leader>p

" Search in current dir
set path=.,,**

" Keep selection after indentation
vnoremap < <gv
vnoremap > >gv
nmap < <<
nmap > >>

" Navigate in command mode
cnoremap <C-a> <Home>
cnoremap <C-e> <End>

" Nightmare mode
"inoremap <Up> <NOP>
"inoremap <Down> <NOP>
"inoremap <Left> <NOP>
"inoremap <Right> <NOP>
"noremap <Up> <NOP>
"noremap <Down> <NOP>
"noremap <Left> <NOP>
"noremap <Right> <NOP>

" Move lines up/down
nmap <S-k> :m-2<CR>
nmap <S-j> :m+<CR>
"imap <S-k> <C-o>:m-2<CR>
"imap <S-j> <C-o>:m+<CR>
vmap <S-k> :m'<-2<CR>gv
vmap <S-j> :m'>+<CR>gv

" Copy lines up/down
"nmap <C-k> :co-1<CR>
"nmap <C-j> :co.<CR>
"imap <C-k> <C-o>:co-1<CR><Down>
"imap <C-j> <C-o>:co.<CR><Up>
"vmap <C-k> :co-1<CR>gv
"vmap <C-j> :co '><CR>gv

" All commands work to the endof the line
nnoremap Y y$

" Switch between splits
nmap <C-h> <C-w>h
nmap <C-j> <C-w>j
nmap <C-k> <C-w>k
nmap <C-l> <C-w>l

" Toggle normal/insert modes
inoremap <C-space> <esc>
nnoremap <C-space> i

" Ctrl+s
nnoremap <C-s> <esc>:w<CR>
inoremap <C-s> <esc>:w<CR>

" Easy search navigation
nmap <Space> <PageDown>
nmap n nzz
nmap N Nzz
nmap * *zz
nmap # #zz
nmap g* g*zz
nmap g# g#zz

" Move in wrapped lines
nnoremap j gj
nnoremap k gk
vnoremap j gj
vnoremap k gk

" Navigate line holding CTRL
inoremap <C-h> <C-o>h
inoremap <C-j> <C-o>gj
inoremap <C-k> <C-o>gk
inoremap <C-l> <C-o>l

" Create splits
nmap <Leader>sh :leftabove  vnew<CR>
nmap <Leader>sl :rightbelow vnew<CR>
nmap <Leader>sk :leftabove  new<CR>
nmap <Leader>sj :rightbelow new<CR>

" Crate split with the current file
noremap <Leader>v <C-w>v

" Close split
noremap <Leader>z :close<CR>

" Tabs
map <Leader>te :tabedit
map <Leader>tc :tabnew %<CR>
map <Leader>tz :tabclose<CR>
map <Leader>tn :tabnext<CR>
map <Leader>tp :tabprev<CR>
map <Leader>to :tabonly<CR>

noremap <silent> <Esc><Esc> :nohlsearch<CR><Esc>

noremap <Leader>s :%s//<Left>
vnoremap <Leader>s :s//<Left>
map <Leader>f :execute "Ack " . expand("<cword>") <Bar> cw<CR>
nnoremap <Leader>S :%s/<C-r>=expand("<cword>")<CR>//<Left>

" Cut line without indentation and trailing spaces
nnoremap <Leader>y ^yg_"_dd

" Formatting, TextMate-style
nnoremap Q gqip
vnoremap Q gq

"imap <Space><Space> .
" Remove trailing spaces
map <Leader>ts :%s/\s\+$//e<CR>

" Buffers
map <Leader>bl :ls<CR>:b
map <Leader>bp :bp<CR>
map <Leader>bn :bn<CR>
map <Leader>bd :bd<CR>

" Tab to navigate braces
nnoremap <Tab> %
vnoremap <Tab> %

" Auto complete {}()[]
inoremap {<CR> {<CR>}<Esc>O
inoremap (<CR> ()<Esc>i
inoremap [<CR> []<Esc>i

" Change current working directory
noremap <Leader>cd :cd %:p:h<CR>:pwd<CR>

" Find merge conflicts
nmap <silent> <leader>fc <ESC>/\v^[<=>]{7}( .*\|$)<CR>
match ErrorMsg '^\(<\|=\|>\)\{7\}\([^=].\+\)\?$'

" Less chording
nnoremap ; :

" Copy filename
map <silent> <leader>. :let @+=expand('%:p').':'.line('.')<CR>
" Copy path
map <silent> <leader>/ :let @+=expand('%:p:h')<CR>

" Save with sudo
"cmap w!! w !sudo tee % >/dev/null
command! W exec 'w !sudo tee % > /dev/null' | e!

" Save when losing focus
autocmd FocusLost * silent! wall
"autocmd BufEnter * lcd %:p:h

" Restore cursor position
set viminfo='10,\"100,:20,%,n~/.viminfo
autocmd BufReadPost * if line("'\"") > 0|if line("'\"") <= line("$")|exe("norm '\"")|else|exe "norm $"|endif|endif

" Resize splits on Vim resize
autocmd VimResized * exe "normal! \<c-w>="

autocmd FileType yaml,ruby,vim,dart setlocal tabstop=2 shiftwidth=2 softtabstop=2

autocmd BufRead,BufNewFile {Gemfile,Rakefile,Vagrantfile,Thorfile,Capfile,config.ru,*rake} set ft=ruby
autocmd BufRead,BufNewFile *.less set ft=less
autocmd BufRead,BufNewFile *.json set ft=json
autocmd BufRead,BufNewFile {*.md,*.mkd,*.markdown} set ft=markdown
autocmd BufRead,BufNewFile *.dart set ft=dart

" Bundles
call plug#begin('~/.vim/bundle')

" Interface
Plug 'mileszs/ack.vim'
Plug 'ervandew/supertab'
Plug 'tpope/vim-surround'
Plug 'tpope/vim-commentary'
Plug 'easymotion/vim-easymotion'
"Plug 'scrooloose/nerdcommenter'
Plug 'scrooloose/nerdtree', { 'on': 'NERDTreeToggle' }
nmap <Bs> :NERDTreeToggle<CR>
map <Leader>n :NERDTreeFind<cr>
let g:NERDTreeWinPos='right'
let g:NERDTreeIgnore=['\.DS_Store$','\.swo$','\.swp$','\.gitignore$','\.git$','\.svn$','\.livereload$','node_modules$','Icon?']
let g:NERDTreeChDirMode=2
let g:NERDTreeShowHidden=1
let g:NERDTreeShowBookmarks=1
let g:NERDTreeQuitOnOpen = 1
let g:NERDTreeKeepTreeInNewTab=0
let g:NERDTreeMinimalUI=1
let g:NERDTreeDirArrows=1

if has("python3")
	Plug 'SirVer/ultisnips'
	let g:UltiSnipsExpandTrigger="<Tab>"
	let g:UltiSnipsJumpForwardTrigger="<Tab>"
	let g:UltiSnipsJumpBackwardTrigger="<S-Tab>"
	Plug 'honza/vim-snippets'
endif

if has("ruby")
	Plug 'wincent/Command-T'
	let g:CommandTAcceptSelectionMap='<C-e>'
	let g:CommandTAcceptSelectionTabMap='<CR>'
endif

Plug 'tpope/vim-fugitive'
nnoremap <Leader>gd :Gdiff<CR>
nnoremap <Leader>gs :Gstatus<CR>
nnoremap <Leader>gw :Gwrite<CR>
nnoremap <Leader>ga :Gadd<CR>
nnoremap <Leader>gb :Gblame<CR>
nnoremap <Leader>gco :Gcheckout<CR>
nnoremap <Leader>gci :Gcommit<CR>
nnoremap <Leader>gmv :Gmove<CR>
nnoremap <Leader>grm :Gremove<CR>
nnoremap <leader>H :Gbrowse<cr>
vnoremap <leader>H :Gbrowse<cr>

Plug 'airblade/vim-gitgutter'

" JavaScript
Plug 'pangloss/vim-javascript', { 'for': 'javascript' }
Plug 'leshill/vim-json', { 'for': 'json' }

" TypeScript
Plug 'leafgarland/typescript-vim', { 'for': 'typescript' }

" HTML
Plug 'mattn/emmet-vim', { 'for': ['html','javascript','typescript'] }
let g:user_emmet_settings = {
\  'php' : {
\    'extends' : 'html',
\    'filters' : 'c',
\  },
\  'xml' : {
\    'extends' : 'html',
\  },
\  'haml' : {
\    'extends' : 'html',
\  },
\}

Plug 'othree/html5.vim', { 'for': 'html' }

" CSS
Plug 'ap/vim-css-color', { 'for': 'css' }
Plug 'hail2u/vim-css3-syntax', { 'for': 'css' }

" Ruby
Plug 'vim-ruby/vim-ruby', { 'for': 'ruby' }
Plug 'tpope/vim-endwise', { 'for': 'ruby' }
Plug 'tpope/vim-rails', { 'for': 'ruby' }

" Erlang
Plug 'oscarh/vimerl', { 'for': 'erlang' }

" Elixir
Plug 'elixir-lang/vim-elixir', { 'for': 'elixir' }

" Scala
Plug 'derekwyatt/vim-scala', { 'for': 'scala' }

" Perl
Plug 'petdance/vim-perl', { 'for': 'perl' }

" Lua
Plug 'xolox/vim-lua-ftplugin', { 'for': 'lua' }
Plug 'xolox/vim-lua-inspect', { 'for': 'lua' }

" Clojure
Plug 'guns/vim-clojure-static', { 'for': 'clojure' }

" Go
Plug 'fatih/vim-go', { 'for': 'go' }

" Rust
Plug 'rust-lang/rust.vim', { 'for': 'rust' }

" Dart
Plug 'dart-lang/dart-vim-plugin', { 'for': 'dart' }

Plug 'altercation/vim-colors-solarized'

call plug#end()

syntax on
if has('gui_running')
	set background=light
else
	set t_Co=256
	set background=dark
	let g:solarized_termcolors=256
endif
colorscheme solarized
