set guioptions-=r " Right Scrollbar
set guioptions-=L " Left scrollbar
set guioptions-=T " Toolbar
set guicursor=n:blinkon0
set guicursor=

if has("gui_macvim")
  macmenu &File.New\ Tab key=<nop>
  map <D-t> :CommandT<CR>

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
  vnoremap <C-y> "+y
  vnoremap <C-x> "+d
  noremap  <C-p> "+gP
  inoremap <C-p> <C-o>"+gP
endif
