" General
set nocompatible
filetype off
set backspace=indent,eol,start

set nonumber
set encoding=utf-8
set fileencodings=utf-8,cp1251
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

" Autocomplete
set wildmode=list:longest
set wildmenu
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
" set linebreak
let &sbr = nr2char(8618).' '
set dictionary=/usr/share/dict/words
if has('mac')
  set guifont=Menlo\ Regular:h13
else
  set guifont=Liberation\ Mono\ 13
end
if has('gui_running')
  set guioptions-=r " Right Scrollbar
  set guioptions-=L " Left scrollbar
  set guioptions-=T " Toolbar
  set guicursor=n:blinkon0
  set guicursor=
endif
" Cursor not blink
set cursorline

set shortmess+=I " No intro screen

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

" Keep selection after indentation
vnoremap > >gv
vnoremap < <gv
nmap > >>
nmap < <<

" Navigate in command mode
cnoremap <C-a> <Home>
cnoremap <C-e> <End>

" Move lines up/down
nmap <S-k> :m-2<CR>
nmap <S-j> :m+<CR>
imap <S-k> <C-o>:m-2<CR>
imap <S-j> <C-o>:m+<CR>
vmap <S-k> :m'<-2<CR>gv
vmap <S-j> :m'>+<CR>gv

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

if has("gui_running")
  if has("gui_macvim") " Special for OS X

    " Tabs navigation
    noremap <D-1> 1gt
    noremap <D-2> 2gt
    noremap <D-3> 3gt
    noremap <D-4> 4gt
    noremap <D-5> 5gt
    noremap <D-6> 6gt
    noremap <D-7> 7gt
    noremap <D-8> 8gt
    noremap <D-9> 9gt
    noremap <D-0> :tablast<CR>

    inoremap <D-1> <C-o>1gt
    inoremap <D-2> <C-o>2gt
    inoremap <D-3> <C-o>3gt
    inoremap <D-4> <C-o>4gt
    inoremap <D-5> <C-o>5gt
    inoremap <D-6> <C-o>6gt
    inoremap <D-7> <C-o>7gt
    inoremap <D-8> <C-o>8gt
    inoremap <D-9> <C-o>9gt
    inoremap <D-0> <C-o>:tablast<CR>

    " Navigate in command mode
    cnoremap <D-Left> <Home>
    cnoremap <D-Right> <End>

    " Move lines up/down
    nmap <D-S-Up>   :m-2<CR>
    nmap <D-S-Down> :m+<CR>
    imap <D-S-Up>   <C-o>:m-2<CR>
    imap <D-S-Down> <C-o>:m+<CR>
    vmap <D-S-Up>   :m'<-2<CR>gv
    vmap <D-S-Down> :m'>+<CR>gv

    " Indentation
    vnoremap <D-[> <gv
    vnoremap <D-]> >gv
    nmap <D-[>  <
    nmap <D-]>  >
    imap <D-[>  <C-o><
    imap <D-]>  <C-o>>

    " Switch between splits
    nmap <D-M-Left>   <C-w>h
    nmap <D-M-Down>   <C-w>j
    nmap <D-M-Up>     <C-w>k
    nmap <D-M-Right>  <C-w>l

    " Move in wrapped lines
    nnoremap <Up>   gk
    nnoremap <Down> gj
    vnoremap <Up>   gk
    vnoremap <Down> gj
    inoremap <Up>   <C-o>gk
    inoremap <Down> <C-o>gj

    " Create splits
    nmap <Leader><Left>  :leftabove  vnew<CR>
    nmap <Leader><Right> :rightbelow vnew<CR>
    nmap <Leader><Up>    :leftabove  new<CR>
    nmap <Leader><Down>  :rightbelow new<CR>

  else

    "Behave
    vnoremap <C-y> "+y
    vnoremap <C-x> "+d
    noremap  <C-p> "+gP
    inoremap <C-p> <C-o>"+gP

  endif
endif
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
  set rtp+=~/.vim/bundle/vundle/
  call vundle#rc()
  Bundle 'gmarik/vundle'

" Interface
  Bundle 'mileszs/ack.vim'
  Bundle 'ervandew/supertab'
  Bundle 'scrooloose/nerdcommenter'
  Bundle 'scrooloose/nerdtree'
  nmap <Bs> :NERDTreeToggle<CR>
  map <Leader>n :NERDTreeFind<cr>
  let g:NERDTreeIgnore=['\.DS_Store$','\.swo$','\.swp$','\.gitignore$','\.git$','\.svn$','\.livereload$','node_modules$','Icon?']
  let g:NERDTreeChDirMode=2
  let g:NERDTreeShowHidden=0
  let g:NERDTreeShowBookmarks=1
  let g:NERDTreeQuitOnOpen = 1
  let g:NERDTreeShowHidden=0
  let g:NERDTreeMinimalUI=1
  let g:NERDTreeDirArrows=1

  "Bundle 'msanders/snipmate'
  if has("python")
    Bundle 'SirVer/ultisnips'
    let g:UltiSnipsExpandTrigger="<Tab>"
    let g:UltiSnipsJumpForwardTrigger="<Tab>"
    let g:UltiSnipsJumpBackwardTrigger="<S-Tab>"
  endif

  if has("ruby")
    Bundle 'wincent/Command-T'
    let g:CommandTAcceptSelectionMap='<C-e>'
    let g:CommandTAcceptSelectionTabMap='<CR>'
  endif

  Bundle 'altercation/vim-colors-solarized'
  syntax on
  if has('gui_running')
    set background=light
  else
    set background=dark
    let g:solarized_termcolors=256
  endif
  colorscheme solarized

  Bundle 'tpope/vim-fugitive'
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

  "Bundle 'tpope/vim-surround'

" JavaScript
  Bundle 'pangloss/vim-javascript'
  Bundle 'itspriddle/vim-jquery'
  Bundle 'leshill/vim-json'

  "Bundle 'kchmck/vim-coffee-script'

" Node.JS
  "Bundle 'wavded/vim-stylus'
  "Bundle 'digitaltoad/vim-jade'

" HTML
  Bundle 'mattn/zencoding-vim'
  let g:user_zen_settings = {
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

  Bundle 'othree/html5.vim'

" CSS
  Bundle 'ap/vim-css-color'
  "Bundle 'miripiruni/vim-better-css-indent'
  Bundle 'hail2u/vim-css3-syntax'
  "Bundle 'miripiruni/CSScomb-for-Vim'

" Ruby
  "Bundle 'vim-ruby/vim-ruby'
  "Bundle 'tpope/vim-endwise'
  "Bundle 'tpope/vim-rails'
  "Bundle 'tpope/vim-rake'
  "Bundle 'tpope/vim-haml'
  "Bundle 'groenewege/vim-less'
  "Bundle 'tpope/vim-cucumber'

" Erlang
  "Bundle 'oscarh/vimerl'

" Perl
  "Bundle 'git://github.com/petdance/vim-perl.git'

" Lua
  "Bundle 'git://github.com/xolox/vim-lua-ftplugin.git'
  "Bundle 'git://github.com/xolox/vim-lua-inspect.git'

" Clojure
  "Bundle 'kotarak/vimclojure'

" Go
  "Bundle 'jnwhiteh/vim-golang'

" Dart
  "Bundle 'lvivski/vim-dart'

filetype plugin indent on