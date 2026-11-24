/* ============================================================
   ATALHOS E HELPERS
   ============================================================ */
const $ = id => document.getElementById(id);
const money = n => new Intl.NumberFormat('pt-MZ',{style:'currency',currency:'MZN'}).format(Number(n)||0);
const escapeHtml = s => String(s??'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const blank = {
  name:'', category:'', sku:'', price:0, stock:0,
  customer:'', items_json:'', total:0, invoice_number:'',
  image:''
};

/* ============================================================
   ★ CAMADA DE PERSISTÊNCIA LOCAL (substitui dataSdk)
   ------------------------------------------------------------
   Mantém a MESMA interface do dataSdk (init/create/update/delete)
   para que o resto do código não precise de ser alterado.
   Os dados ficam guardados no localStorage do navegador.
   ============================================================ */
const STORAGE_KEY = 'doce_co_records_v1';

const dataSdk = (() => {
  let cache = [];          // array de registos em memória
  let onChanged = null;    // callback registado no init()

  // Lê o array do localStorage (com fallback seguro)
  function read(){
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    }catch(err){
      console.warn('Falha a ler dados do localStorage, a começar vazio.', err);
      return [];
    }
  }

  // Escreve o array no localStorage
  function write(arr){
    try{
      localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
      return true;
    }catch(err){
      console.error('Falha a escrever no localStorage', err);
      return false;
    }
  }

  // Gera um ID único (equivalente ao __backendId)
  function newId(){
    return 'rec_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,9);
  }

  // Notifica o exterior que os dados mudaram
  function emit(){
    if(typeof onChanged === 'function'){
      // envia uma cópia para evitar mutações externas
      onChanged(cache.map(x => ({...x})));
    }
  }

  return {
    // init({onDataChanged}) — devolve {isOk:true}
    async init(opts = {}){
      onChanged = opts.onDataChanged || null;
      cache = read();
      emit();
      return {isOk:true, data: cache};
    },

    // create(data) — adiciona um registo
    async create(data){
      const record = {...data, __backendId: newId(), created_at: data.created_at || new Date().toISOString()};
      cache.push(record);
      if(!write(cache)) return {isOk:false, error:'write_failed'};
      emit();
      return {isOk:true, data:{...record}};
    },

    // update(data) — atualiza pelo __backendId
    async update(data){
      if(!data?.__backendId) return {isOk:false, error:'missing_id'};
      const idx = cache.findIndex(x => x.__backendId === data.__backendId);
      if(idx === -1) return {isOk:false, error:'not_found'};
      cache[idx] = {...cache[idx], ...data};
      if(!write(cache)) return {isOk:false, error:'write_failed'};
      emit();
      return {isOk:true, data:{...cache[idx]}};
    },

    // delete(record) — remove pelo __backendId
    async delete(record){
      if(!record?.__backendId) return {isOk:false, error:'missing_id'};
      const before = cache.length;
      cache = cache.filter(x => x.__backendId !== record.__backendId);
      if(cache.length === before) return {isOk:false, error:'not_found'};
      if(!write(cache)) return {isOk:false, error:'write_failed'};
      emit();
      return {isOk:true};
    },

    // Expor lista (útil para debug)
    all(){ return cache.map(x => ({...x})); }
  };
})();

// expõe globalmente (o código mais abaixo chama window.dataSdk)
window.dataSdk = dataSdk;

/* ============================================================
   ESTADO GLOBAL
   ============================================================ */
let records = [];
let draft = [];
let editingId = null;
let ready = false;
let busy = false;
let posCart = [];

// Imagem atualmente selecionada no modal (data URL) e imagem original (para edição)
let pendingImageDataUrl = '';
let currentEditingImage = '';

/* ============================================================
   MESAS — estado e persistência
   ------------------------------------------------------------
   Cada mesa: { id, name, opened_at, orders:[{id,name,price,quantity}] }
   Guardadas em localStorage (chave própria), independentes das facturas.
   O stock só é abatido quando a conta é fechada.
   ============================================================ */
const TABLES_KEY = 'doce_co_tables_v1';
let tables = [];               // todas as mesas abertas
let activeTableId = null;      // mesa atualmente em edição no painel

function readTables(){
  try{
    const raw = localStorage.getItem(TABLES_KEY);
    return raw ? JSON.parse(raw) : [];
  }catch(err){ return []; }
}
function writeTables(arr){
  try{ localStorage.setItem(TABLES_KEY, JSON.stringify(arr)); return true; }
  catch(err){ console.error('Falha a guardar mesas', err); return false; }
}
function newTableId(){ return 'tbl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,7); }

const products = () => records.filter(x => x.record_type === 'product');
const invoices = () => records.filter(x => x.record_type === 'invoice');

/* ============================================================
   IMAGEM — redimensiona e converte para data URL (JPEG)
   ------------------------------------------------------------
   - Limita o lado maior a `maxSize` px.
   - Qualidade JPEG configurável.
   - Se o ficheiro for pequeno, evita redimensionar.
   ============================================================ */
function fileToResizedDataURL(file, maxSize = 600, quality = 0.8) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('O ficheiro não é uma imagem.'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Não foi possível ler a imagem.'));
      img.onload = () => {
        let { width, height } = img;
        // Só redimensiona se exceder o limite
        if (width > maxSize || height > maxSize) {
          if (width >= height) {
            height = Math.round((height * maxSize) / width);
            width = maxSize;
          } else {
            width = Math.round((width * maxSize) / height);
            height = maxSize;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        // Fundo branco para PNGs com transparência (JPEG não suporta alpha)
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ============================================================
   UPLOAD DE IMAGEM — pré-visualização e remoção (defensivo)
   ------------------------------------------------------------
   Se o HTML não tiver os elementos (#product-image, etc.),
   não rebenta — apenas não liga os handlers.
   ============================================================ */
(function initImageUpload(){
  const input  = $('product-image');
  const remove = $('product-image-remove');

  if(input){
    input.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const dataUrl = await fileToResizedDataURL(file, 600, 0.8);
        pendingImageDataUrl = dataUrl;

        const thumb = $('product-image-thumb');
        const wrap  = $('product-image-preview');
        if(thumb) thumb.src = dataUrl;
        if(wrap)  wrap.style.display = 'block';
      } catch (err) {
        notice(err.message || 'Não foi possível carregar a imagem.');
        e.target.value = ''; // limpa input
      }
    });
  }

  if(remove){
    remove.addEventListener('click', () => {
      pendingImageDataUrl = '';
      currentEditingImage = '';        // força remover mesmo em edição
      if(input) input.value = '';
      const thumb = $('product-image-thumb');
      const wrap  = $('product-image-preview');
      if(thumb) thumb.src = '';
      if(wrap)  wrap.style.display = 'none';
    });
  }
})();

/* ============================================================
   NOTIFICAÇÕES
   ============================================================ */
function notice(text, type='error'){
  const el = $('status');
  el.textContent = text;
  el.className = 'status show ' + type;
  el.scrollIntoView({behavior:'smooth', block:'nearest'});
}

/* ============================================================
   SIDEBAR — ABRIR / FECHAR / COLAPSAR
   ------------------------------------------------------------
   - Desktop (>900px): botão "panel-left-close" colapsa a sidebar.
   - Mobile (<=900px): botão "menu" no header abre como overlay.
   ============================================================ */
const SIDEBAR_KEY = 'doce_co_sidebar_collapsed';
const MOBILE_BP = 900;

function isMobile(){ return window.matchMedia('(max-width:'+MOBILE_BP+'px)').matches; }

function applySidebarState(){
  document.body.classList.toggle('sidebar-collapsed',
    localStorage.getItem(SIDEBAR_KEY) === '1' && !isMobile()
  );
  updateToggleIcon();
}

function updateToggleIcon(){
  const btn = $('sidebar-toggle');
  if(!btn) return;
  const collapsed = document.body.classList.contains('sidebar-collapsed');
  const open = document.body.classList.contains('sidebar-open');
  const iconName = isMobile()
    ? (open ? 'panel-left-close' : 'panel-left-open')
    : (collapsed ? 'panel-left-open' : 'panel-left-close');
  btn.innerHTML = '<i data-lucide="'+iconName+'"></i>';
  btn.setAttribute('aria-expanded', String(isMobile() ? open : !collapsed));
  lucide.createIcons();
}

// Clique no botão de toggle (dentro da sidebar)
const sbToggle = $('sidebar-toggle');
if(sbToggle){
  sbToggle.addEventListener('click', () => {
    if(isMobile()){
      document.body.classList.remove('sidebar-open');
      updateToggleIcon();
    } else {
      const collapsed = document.body.classList.toggle('sidebar-collapsed');
      localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
      updateToggleIcon();
    }
  });
}

// Clique no botão hambúrguer (header, só mobile)
const menuBtn = $('menu-button');
if(menuBtn){
  menuBtn.addEventListener('click', () => {
    document.body.classList.toggle('sidebar-open');
    updateToggleIcon();
  });
}

// Clique no backdrop fecha a sidebar no mobile
const sbBackdrop = $('sidebar-backdrop');
if(sbBackdrop){
  sbBackdrop.addEventListener('click', () => {
    document.body.classList.remove('sidebar-open');
    updateToggleIcon();
  });
}

// ESC fecha a sidebar no mobile
document.addEventListener('keydown', e => {
  if(e.key === 'Escape' && document.body.classList.contains('sidebar-open')){
    document.body.classList.remove('sidebar-open');
    updateToggleIcon();
  }
});

// Reavaliar ao redimensionar (transição entre mobile/desktop)
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if(!isMobile()){
      document.body.classList.remove('sidebar-open');
    }
    applySidebarState();
  }, 120);
});

// Estado inicial da sidebar
applySidebarState();

/* ============================================================
   NAVEGAÇÃO ENTRE VIEWS
   ============================================================ */
function setView(view){
  document.querySelectorAll('.view').forEach(e => e.classList.toggle('active', e.id === view));
  document.querySelectorAll('.nav-button').forEach(e => e.classList.toggle('active', e.dataset.view === view));

  const titles = {
    overview:['Bom dia, pastelaria!','Uma visão simples do seu negócio.'],
    products:['As suas mercadorias','Mantenha tudo organizado e actualizado.'],
    vendas:['Vendas','Pesquise por código de barras e registe vendas rapidamente.'],
    tables:['Mesas','Pedidos abertos e fecho de conta.'],
    billing:['Facturação','Cada venda, bem registada.'],
    reports:['Relatórios','Analise as vendas por dia e por período.']
  };
  $('page-title').textContent = titles[view][0];
  $('page-subtitle').textContent = titles[view][1];
  $('status').className = 'status';

  if(isMobile()){
    document.body.classList.remove('sidebar-open');
    updateToggleIcon();
  }

  if(view === 'vendas'){
    renderPosResults();
    setTimeout(() => $('pos-barcode').focus(), 80);
  }

  if(view === 'tables'){
    renderTables();
    if(activeTableId && tables.some(t => t.id === activeTableId)){
      openTableDetail(activeTableId);
    } else {
      activeTableId = null;
      $('table-detail').style.display = 'none';
    }
  }

  if(view === 'reports'){
    if(!reportState.from && !reportState.to) applyPreset('today');
    else renderReport();
  }
}

/* ============================================================
   TABELA GENÉRICA DE PRODUTOS
   ------------------------------------------------------------
   - Miniatura dentro do <td class="product-name"> quando existe.
   - Ações Editar/Eliminar na última coluna (quando actions=true).
   ============================================================ */
function table(rows, actions=false){
  if(!rows.length){
    return '<div class="empty"><i data-lucide="package-open"></i>Ainda não há mercadorias para mostrar.</div>';
  }
  return '<table><thead><tr>'+
      '<th>Mercadoria</th><th>Referência</th><th>Categoria</th><th>Preço</th><th>Stock</th>'+
      (actions?'<th>Acções</th>':'')+
    '</tr></thead><tbody>'+
    rows.map(p => '<tr>'+
      '<td class="product-name">'+
        (p.image
          ? '<img src="'+escapeHtml(p.image)+'" alt="" '+
            'style="width:34px;height:34px;object-fit:cover;border-radius:8px;'+
            'border:1px solid #ebe3da;vertical-align:middle;margin-right:8px">'
          : '')+
        escapeHtml(p.name)+
      '</td>'+
      '<td>'+escapeHtml(p.sku)+'</td>'+
      '<td><span class="badge">'+escapeHtml(p.category)+'</span></td>'+
      '<td>'+money(p.price)+'</td>'+
      '<td><span class="badge '+(Number(p.stock)<5?'low':'')+'">'+Number(p.stock)+'</span></td>'+
      (actions?'<td class="action-cell">'+
        '<button class="button ghost small" data-edit="'+escapeHtml(p.__backendId)+'">Editar</button>'+
        '<button class="button danger small" data-delete="'+escapeHtml(p.__backendId)+'">Eliminar</button>'+
      '</td>':'')+
    '</tr>').join('')+'</tbody></table>';
}

/* ============================================================
   RENDER PRINCIPAL
   ============================================================ */
function render(){
  const p = products();
  const inv = invoices().sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)));

  $('stat-products').textContent = p.length;
  $('stat-stock').textContent = p.reduce((a,x) => a+Number(x.stock||0), 0);
  $('stat-invoices').textContent = inv.length;
  $('stat-revenue').textContent = money(inv.reduce((a,x) => a+Number(x.total||0), 0));

  $('recent-products').innerHTML = table(
    [...p].sort((a,b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0,5)
  );

  const q = $('product-search').value.toLocaleLowerCase();
  const filtered = p.filter(x => (x.name+' '+x.sku).toLocaleLowerCase().includes(q));
  $('product-table').innerHTML = table(filtered, true);
  $('product-count').textContent = filtered.length+' artigos';

  $('invoice-product').innerHTML = '<option value="">Seleccione uma mercadoria</option>'+
    p.filter(x => Number(x.stock)>0)
     .map(x => '<option value="'+escapeHtml(x.__backendId)+'">'+escapeHtml(x.name)+' — '+money(x.price)+' ('+Number(x.stock)+' em stock)</option>')
     .join('');

  $('invoice-history').innerHTML = inv.length
    ? inv.slice(0,12).map(x => '<button class="quick-action" style="width:100%;margin:8px 0" data-invoice="'+escapeHtml(x.__backendId)+'">'+
        '<i data-lucide="receipt"></i>'+
        '<span style="flex:1"><span style="display:block">'+escapeHtml(x.invoice_number)+'</span>'+
        '<small style="color:var(--muted);font-weight:400">'+escapeHtml(x.customer||'Cliente balcão')+'</small></span>'+
        '<strong>'+money(x.total)+'</strong>'+
      '</button>').join('')
    : '<div class="empty">Ainda não há facturas emitidas.</div>';

  renderDraft();
  renderPosResults();
  renderPosCart();
  renderTables();                          // mantém a grelha de mesas sincronizada
  if($('report-table')) renderReport();
  lucide.createIcons();
}

/* ============================================================
   FACTURAÇÃO (draft)
   ============================================================ */
function renderDraft(){
  $('invoice-lines').innerHTML = draft.length
    ? draft.map((x,i) => '<div class="invoice-line">'+
        '<strong>'+escapeHtml(x.name)+'</strong>'+
        '<span>'+x.quantity+' un.</span>'+
        '<span>'+money(x.price*x.quantity)+'</span>'+
        '<button class="icon-button" data-remove-line="'+i+'" aria-label="Remover '+escapeHtml(x.name)+'"><i data-lucide="x"></i></button>'+
      '</div>').join('')
    : '<div class="empty">Adicione artigos para começar a factura.</div>';
  $('draft-total').textContent = money(draft.reduce((a,x) => a+x.price*x.quantity, 0));
  lucide.createIcons();
}

/* ============================================================
   POS
   ============================================================ */
function posFindByBarcode(code){
  const c = String(code||'').trim().toLowerCase();
  if(!c) return null;
  return products().find(x => String(x.sku||'').toLowerCase() === c) || null;
}

function posAddProduct(p, qty=1){
  if(!p) return;
  if(Number(p.stock) <= 0){ notice('Sem stock disponível para "'+p.name+'".'); return; }

  const existing = posCart.find(x => x.id === p.__backendId);
  const currentQty = existing?.quantity || 0;
  if(currentQty + qty > Number(p.stock)){
    notice('Stock insuficiente para "'+p.name+'". Disponível: '+p.stock);
    return;
  }
  if(existing) existing.quantity += qty;
  else posCart.push({id:p.__backendId, name:p.name, price:Number(p.price), quantity:qty});

  $('status').className = 'status';
  renderPosCart();
}

function renderPosResults(){
  if(!$('pos-results')) return;
  const q = ($('pos-search').value||'').trim().toLowerCase();
  const list = products().filter(x => {
    if(!q) return true;
    return (x.name+' '+x.sku+' '+x.category).toLowerCase().includes(q);
  }).slice(0,40);

  $('pos-results').innerHTML = list.length
    ? list.map(x => {
        const stock = Number(x.stock||0);
        return '<button class="pos-card" data-pos-add="'+escapeHtml(x.__backendId)+'" '+(stock<=0?'disabled':'')+'>'+
          (x.image
            ? '<img src="'+escapeHtml(x.image)+'" alt="" '+
              'style="width:100%;height:70px;object-fit:cover;border-radius:8px;margin-bottom:4px">'
            : '')+
          '<span class="pc-name">'+escapeHtml(x.name)+'</span>'+
          '<span class="pc-meta">'+escapeHtml(x.sku)+' · '+escapeHtml(x.category)+'</span>'+
          '<span class="pc-price">'+money(x.price)+'</span>'+
          '<span class="pc-stock '+(stock<5?'low':'')+'">'+(stock>0?stock+' em stock':'Sem stock')+'</span>'+
        '</button>';
      }).join('')
    : '<div class="empty"><i data-lucide="search-x"></i>Nenhum produto encontrado.</div>';
  lucide.createIcons();
}

function renderPosCart(){
  if(!$('pos-cart')) return;
  const total = posCart.reduce((a,x) => a+x.price*x.quantity, 0);
  const count = posCart.reduce((a,x) => a+x.quantity, 0);
  $('pos-total').textContent = money(total);
  $('pos-cart-count').textContent = count+(count===1?' artigo':' artigos');

  if(!posCart.length){
    $('pos-cart').innerHTML = '<div class="empty"><i data-lucide="shopping-cart"></i>O carrinho está vazio.<br><small>Leia um código de barras ou escolha um produto.</small></div>';
  } else {
    $('pos-cart').innerHTML = posCart.map((x,i) => '<div class="cart-line">'+
      '<div class="cl-name">'+escapeHtml(x.name)+'<small>'+money(x.price)+' / un.</small></div>'+
      '<div class="qty-controls">'+
        '<button data-pos-qty="'+i+'" data-pos-delta="-1" aria-label="Diminuir"><i data-lucide="minus"></i></button>'+
        '<span>'+x.quantity+'</span>'+
        '<button data-pos-qty="'+i+'" data-pos-delta="1" aria-label="Aumentar"><i data-lucide="plus"></i></button>'+
      '</div>'+
      '<div class="cl-sub">'+money(x.price*x.quantity)+'</div>'+
      '<button class="icon-button" data-pos-remove="'+i+'" aria-label="Remover"><i data-lucide="trash-2"></i></button>'+
    '</div>').join('');
  }
  lucide.createIcons();
}

function posCheckout(){
  if(!ready || busy) return;
  if(!posCart.length){ notice('Adicione pelo menos um artigo à venda.'); return; }

  for(const line of posCart){
    const p = products().find(x => x.__backendId === line.id);
    if(!p || Number(p.stock) < line.quantity){
      notice('O stock mudou. Reveja os artigos antes de finalizar.');
      return;
    }
  }
  if(records.length >= 999){ notice('Limite de 999 registos atingido.'); return; }

  busy = true;
  $('pos-checkout').disabled = true;
  $('pos-checkout').textContent = 'A processar…';

  const lines = posCart.map(x => ({...x}));
  const invoice = {
    record_type:'invoice',
    ...blank,
    customer: ($('pos-customer').value.trim() || 'Cliente balcão'),
    items_json: JSON.stringify(lines.map(({name,price,quantity}) => ({name,price,quantity}))),
    total: lines.reduce((a,x) => a+x.price*x.quantity, 0),
    invoice_number: 'FT-'+Date.now().toString(36).toUpperCase(),
    created_at: new Date().toISOString()
  };

  (async () => {
    try{
      const r = await window.dataSdk.create(invoice);
      if(!r.isOk){ notice('Não foi possível registar a venda. Tente novamente.'); return; }

      let failed = false;
      for(const line of lines){
        const p = products().find(x => x.__backendId === line.id);
        if(!p){ failed = true; continue; }
        const updated = await window.dataSdk.update({...p, stock: Number(p.stock) - line.quantity});
        if(!updated.isOk) failed = true;
        else p.stock = Number(p.stock) - line.quantity;
      }

      posCart = [];
      $('pos-customer').value = '';
      render();

      notice(failed
        ? 'Venda registada, mas não foi possível actualizar todo o stock.'
        : 'Venda registada e stock actualizado.', 'success');

      const inv = records.find(x => x.__backendId === r.data?.__backendId) || null;
      if(inv) showInvoicePaper(inv);
    }catch(err){
      notice('Ocorreu um erro. Verifique o histórico antes de tentar novamente.');
    }finally{
      busy = false;
      $('pos-checkout').disabled = false;
      $('pos-checkout').innerHTML = '<i data-lucide="check"></i> Finalizar venda';
      lucide.createIcons();
    }
  })();
}

function showInvoicePaper(inv){
  let items = [];
  try{ items = JSON.parse(inv.items_json||'[]'); }catch(err){}

  $('invoice-paper').innerHTML =
    '<div class="paper-top">'+
      '<div><h2>GSP</h2><p class="subtle">GLOBAL SERVICES &amp; PROJECT SOC UNIP LDA</p></div>'+
      '<div style="text-align:right"><strong>'+escapeHtml(inv.invoice_number)+'</strong><br>'+
      '<span class="subtle">'+new Date(inv.created_at).toLocaleDateString('pt-PT')+'</span></div>'+
    '</div>'+
    '<p><strong>Cliente:</strong> '+escapeHtml(inv.customer)+'</p>'+
    '<table><thead><tr><th>Artigo</th><th>Qtd.</th><th>Preço</th><th>Subtotal</th></tr></thead><tbody>'+
      items.map(x => '<tr>'+
        '<td>'+escapeHtml(x.name)+'</td>'+
        '<td>'+Number(x.quantity)+'</td>'+
        '<td>'+money(x.price)+'</td>'+
        '<td>'+money(x.price*x.quantity)+'</td>'+
      '</tr>').join('')+
    '</tbody></table>'+
    '<div class="paper-total">Total: '+money(inv.total)+'</div>'+
    '<p class="subtle" style="margin-top:35px">Documento de gestão interna. Confirme os requisitos fiscais aplicáveis antes de utilizar como factura fiscal.</p>';

  $('invoice-modal').classList.add('open');
  lucide.createIcons();
}

/* ============================================================
   EVENTOS GERAIS
   ============================================================ */
document.querySelectorAll('.nav-button').forEach(b => b.onclick = () => setView(b.dataset.view));

const quickProduct = $('quick-product');  if(quickProduct) quickProduct.onclick = () => { setView('products'); openProduct(); };
const quickVenda   = $('quick-venda');    if(quickVenda)   quickVenda.onclick   = () => setView('vendas');
const quickInvoice = $('quick-invoice');  if(quickInvoice) quickInvoice.onclick = () => setView('billing');

const addProductBtn = $('add-product');   if(addProductBtn) addProductBtn.onclick = () => openProduct();

const productSearch = $('product-search'); if(productSearch) productSearch.oninput = render;

document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => closeModal(b.dataset.close));
document.addEventListener('keydown', e => {
  if(e.key === 'Escape') document.querySelectorAll('.modal-backdrop.open').forEach(m => closeModal(m.id));
});

/* ============================================================
   MODAL DE PRODUTO
   ============================================================ */
function openProduct(p){
  editingId = p?.__backendId || null;
  $('product-modal-title').textContent = p ? 'Editar mercadoria' : 'Nova mercadoria';
  $('product-submit').textContent = p ? 'Guardar alterações' : 'Guardar mercadoria';

  $('product-name').value = p?.name || '';
  $('product-sku').value = p?.sku || '';
  $('product-category').value = p?.category || 'Pastelaria';
  $('product-price').value = p?.price ?? '';
  $('product-stock').value = p?.stock ?? '';

  /* --- Imagem (tolerante à ausência dos elementos no HTML) --- */
  pendingImageDataUrl = '';
  currentEditingImage = p?.image || '';

  const input = $('product-image');
  const thumb = $('product-image-thumb');
  const wrap  = $('product-image-preview');

  if(input) input.value = '';
  if(currentEditingImage){
    if(thumb) thumb.src = currentEditingImage;
    if(wrap)  wrap.style.display = 'block';
  } else {
    if(thumb) thumb.src = '';
    if(wrap)  wrap.style.display = 'none';
  }

  $('product-modal').classList.add('open');
  $('product-name').focus();
  lucide.createIcons();
}

function closeModal(id){ $(id).classList.remove('open'); }

/* ============================================================
   FORMULÁRIO DE PRODUTO
   ============================================================ */
$('product-form').onsubmit = async e => {
  e.preventDefault();
  if(!ready || busy) return;

  const name = $('product-name').value.trim();
  const sku = $('product-sku').value.trim();
  const price = Number($('product-price').value);
  const stock = Number($('product-stock').value);

  if(!name || !sku || !Number.isFinite(price) || price < 0 || !Number.isInteger(stock) || stock < 0){
    notice('Verifique os dados da mercadoria.'); return;
  }
  if(products().some(x => x.sku.toLowerCase() === sku.toLowerCase() && x.__backendId !== editingId)){
    notice('Já existe uma mercadoria com esta referência/código de barras.'); return;
  }
  if(!editingId && records.length >= 999){ notice('Limite de 999 registos atingido.'); return; }

  busy = true;
  $('product-submit').disabled = true;
  $('product-submit').textContent = 'A guardar…';

  const data = {
    record_type:'product',
    ...blank,
    name, sku,
    category:$('product-category').value,
    price, stock,
    image: pendingImageDataUrl || currentEditingImage || '',
    created_at: new Date().toISOString()
  };

  try{
    const old = records.find(x => x.__backendId === editingId);
    const result = old
      ? await window.dataSdk.update({...old, ...data, created_at: old.created_at})
      : await window.dataSdk.create(data);

    if(result.isOk){
      closeModal('product-modal');
      notice(old ? 'Mercadoria actualizada.' : 'Mercadoria cadastrada.', 'success');
    } else {
      notice('Não foi possível guardar a mercadoria. Tente novamente.');
    }
  }catch(err){
    notice('Não foi possível guardar a mercadoria. Tente novamente.');
  }finally{
    busy = false;
    $('product-submit').disabled = false;
    $('product-submit').textContent = editingId ? 'Guardar alterações' : 'Guardar mercadoria';
  }
};

/* ============================================================
   ACÇÕES NA TABELA DE PRODUTOS
   ============================================================ */
$('product-table').onclick = async e => {
  const edit = e.target.closest('[data-edit]');
  const del = e.target.closest('[data-delete]');
  const yes = e.target.closest('[data-confirm-delete]');
  const cancel = e.target.closest('[data-cancel-delete]');

  if(edit){ openProduct(records.find(x => x.__backendId === edit.dataset.edit)); return; }

  if(del){
    const cell = del.closest('td');
    cell.innerHTML = '<button class="button danger small" data-confirm-delete="'+escapeHtml(del.dataset.delete)+'">Confirmar?</button>'+
                     '<button class="button ghost small" data-cancel-delete>Cancelar</button>';
    return;
  }
  if(cancel){ render(); return; }

  if(yes && !busy){
    const p = records.find(x => x.__backendId === yes.dataset.confirmDelete);
    if(!p) return;
    busy = true; yes.disabled = true; yes.textContent = 'A eliminar…';
    try{
      const r = await window.dataSdk.delete(p);
      notice(r.isOk ? 'Mercadoria eliminada.' : 'Não foi possível eliminar a mercadoria.', r.isOk ? 'success' : 'error');
    }catch(err){
      notice('Não foi possível eliminar a mercadoria.');
    }finally{
      busy = false; render();
    }
  }
};

/* ============================================================
   FACTURAÇÃO — EVENTOS
   ============================================================ */
$('add-line').onclick = () => {
  const p = products().find(x => x.__backendId === $('invoice-product').value);
  const quantity = Number($('invoice-quantity').value);
  if(!p || !Number.isInteger(quantity) || quantity < 1){
    notice('Seleccione uma mercadoria e uma quantidade válida.'); return;
  }
  const existing = draft.find(x => x.id === p.__backendId);
  if((existing?.quantity || 0) + quantity > Number(p.stock)){
    notice('Quantidade superior ao stock disponível.'); return;
  }
  if(existing) existing.quantity += quantity;
  else draft.push({id:p.__backendId, name:p.name, price:Number(p.price), quantity});
  renderDraft();
  $('status').className = 'status';
};

$('invoice-lines').onclick = e => {
  const b = e.target.closest('[data-remove-line]');
  if(b){ draft.splice(Number(b.dataset.removeLine), 1); renderDraft(); }
};

$('save-invoice').onclick = async () => {
  if(!ready || busy) return;
  if(!draft.length){ notice('Adicione pelo menos um artigo à factura.'); return; }
  for(const line of draft){
    const p = products().find(x => x.__backendId === line.id);
    if(!p || Number(p.stock) < line.quantity){
      notice('O stock mudou. Reveja os artigos antes de emitir.'); return;
    }
  }
  if(records.length >= 999){ notice('Limite de 999 registos atingido.'); return; }

  busy = true;
  $('save-invoice').disabled = true;
  $('save-invoice').textContent = 'A emitir…';

  const lines = draft.map(x => ({...x}));
  const invoice = {
    record_type:'invoice', ...blank,
    customer: $('customer-name').value.trim() || 'Cliente balcão',
    items_json: JSON.stringify(lines.map(({name,price,quantity}) => ({name,price,quantity}))),
    total: lines.reduce((a,x) => a+x.price*x.quantity, 0),
    invoice_number: 'FT-'+Date.now().toString(36).toUpperCase(),
    created_at: new Date().toISOString()
  };

  try{
    const r = await window.dataSdk.create(invoice);
    if(!r.isOk){ notice('Não foi possível emitir a factura. Tente novamente.'); return; }

    let failed = false;
    for(const line of lines){
      const p = products().find(x => x.__backendId === line.id);
      if(!p){ failed = true; continue; }
      const updated = await window.dataSdk.update({...p, stock: Number(p.stock) - line.quantity});
      if(!updated.isOk) failed = true;
      else p.stock = Number(p.stock) - line.quantity;
    }
    draft = [];
    $('customer-name').value = '';
    render();
    notice(failed
      ? 'Factura guardada, mas não foi possível actualizar todo o stock. Corrija as quantidades nas mercadorias.'
      : 'Factura emitida e stock actualizado.', failed ? 'error' : 'success');
  }catch(err){
    notice('Ocorreu um erro. Verifique o histórico antes de tentar novamente.');
  }finally{
    busy = false;
    $('save-invoice').disabled = false;
    $('save-invoice').innerHTML = '<i data-lucide="check"></i> Emitir factura';
    lucide.createIcons();
  }
};

$('invoice-history').onclick = e => {
  const b = e.target.closest('[data-invoice]');
  if(!b) return;
  const inv = records.find(x => x.__backendId === b.dataset.invoice);
  if(!inv) return;
  showInvoicePaper(inv);
};

$('print-invoice').onclick = () => window.print();

/* ============================================================
   POS — EVENTOS
   ============================================================ */
$('pos-search').oninput = renderPosResults;

$('pos-results').onclick = e => {
  const b = e.target.closest('[data-pos-add]');
  if(!b || b.disabled) return;
  const p = products().find(x => x.__backendId === b.dataset.posAdd);
  posAddProduct(p, 1);
};

$('pos-barcode-add').onclick = () => {
  const code = $('pos-barcode').value.trim();
  if(!code){ notice('Introduza um código de barras ou referência.'); return; }
  const p = posFindByBarcode(code);
  if(!p){ notice('Nenhum produto encontrado com o código "'+code+'".'); return; }
  posAddProduct(p, 1);
  $('pos-barcode').value = '';
  $('pos-barcode').focus();
};

$('pos-barcode').addEventListener('keydown', e => {
  if(e.key === 'Enter'){ e.preventDefault(); $('pos-barcode-add').click(); }
});

$('pos-cart').onclick = e => {
  const qty = e.target.closest('[data-pos-qty]');
  const rem = e.target.closest('[data-pos-remove]');
  if(qty){
    const i = Number(qty.dataset.posQty);
    const delta = Number(qty.dataset.posDelta);
    const line = posCart[i];
    if(!line) return;
    const p = products().find(x => x.__backendId === line.id);
    const newQty = line.quantity + delta;
    if(newQty <= 0){ posCart.splice(i, 1); }
    else if(p && newQty > Number(p.stock)){ notice('Stock insuficiente para "'+line.name+'".'); return; }
    else { line.quantity = newQty; }
    renderPosCart();
    return;
  }
  if(rem){ posCart.splice(Number(rem.dataset.posRemove), 1); renderPosCart(); }
};

$('pos-clear').onclick = () => {
  if(!posCart.length && !$('pos-customer').value) return;
  posCart = [];
  $('pos-customer').value = '';
  renderPosCart();
  notice('Venda limpa.', 'success');
};

$('pos-checkout').onclick = posCheckout;

/* ============================================================
   RELATÓRIOS DE VENDAS
   ============================================================ */

// Estado atual do filtro (data local ISO: YYYY-MM-DD)
const reportState = { from:'', to:'', preset:'' };

// Converte uma data local (YYYY-MM-DD) em "chave" de comparação
const dateKey = iso => iso ? iso.slice(0,10) : '';

// Hoje em ISO local (não UTC)
function todayISO(){
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off*60000).toISOString().slice(0,10);
}

// Soma N dias a uma data ISO
function addDaysISO(iso, days){
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0,10);
}

// Aplica um preset ("today", "yesterday", "7d", "30d", "month")
function applyPreset(preset){
  const today = todayISO();
  let from = today, to = today;

  if(preset === 'today'){ /* from=to=today */ }
  else if(preset === 'yesterday'){ from = to = addDaysISO(today, -1); }
  else if(preset === '7d'){ from = addDaysISO(today, -6); to = today; }
  else if(preset === '30d'){ from = addDaysISO(today, -29); to = today; }
  else if(preset === 'month'){
    const d = new Date(today + 'T00:00:00');
    from = new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0,10);
    to = today;
  }

  $('report-from').value = from;
  $('report-to').value = to;
  reportState.from = from;
  reportState.to = to;
  reportState.preset = preset;

  document.querySelectorAll('#report-presets .preset').forEach(b =>
    b.classList.toggle('active', b.dataset.preset === preset)
  );

  renderReport();
}

// Devolve as facturas dentro do período selecionado
function invoicesInRange(){
  const from = reportState.from || '0000-00-00';
  const to = reportState.to || '9999-99-99';
  return invoices()
    .filter(inv => {
      const k = dateKey(inv.created_at);
      return k >= from && k <= to;
    })
    .sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)));
}

// Soma as unidades de uma factura
function invoiceUnits(inv){
  try{
    const items = JSON.parse(inv.items_json || '[]');
    return items.reduce((a,x) => a + Number(x.quantity||0), 0);
  }catch(err){ return 0; }
}

// Desenha o relatório completo
function renderReport(){
  const list = invoicesInRange();

  // ---- Totais do período ----
  const totalRevenue = list.reduce((a,x) => a + Number(x.total||0), 0);
  const totalUnits = list.reduce((a,x) => a + invoiceUnits(x), 0);
  const avg = list.length ? totalRevenue / list.length : 0;

  $('rep-count').textContent = list.length;
  $('rep-units').textContent = totalUnits;
  $('rep-revenue').textContent = money(totalRevenue);
  $('rep-avg').textContent = money(avg);

  // ---- Resumo diário (agrupa por dia) ----
  const byDay = {};
  list.forEach(inv => {
    const k = dateKey(inv.created_at);
    if(!byDay[k]) byDay[k] = {date:k, count:0, units:0, total:0};
    byDay[k].count += 1;
    byDay[k].units += invoiceUnits(inv);
    byDay[k].total += Number(inv.total||0);
  });
  const days = Object.values(byDay).sort((a,b) => b.date.localeCompare(a.date));
  const maxTotal = Math.max(1, ...days.map(d => d.total));

  $('report-daily').innerHTML = days.length
    ? days.map(d => {
        const pct = Math.round((d.total / maxTotal) * 100);
        const dt = new Date(d.date + 'T00:00:00');
        const label = dt.toLocaleDateString('pt-PT', {weekday:'short', day:'2-digit', month:'short'});
        return '<div class="daily-row">' +
          '<span class="dr-date">' + label + '</span>' +
          '<span class="dr-bar"><span style="width:' + pct + '%"></span></span>' +
          '<span class="dr-count">' + d.count + ' vendas · ' + d.units + ' un.</span>' +
          '<span class="dr-total">' + money(d.total) + '</span>' +
        '</div>';
      }).join('')
    : '<div class="report-empty"><i data-lucide="calendar-x"></i>Sem vendas no período selecionado.</div>';

  // ---- Tabela de vendas ----
  if(!list.length){
    $('report-table').innerHTML = '<div class="report-empty"><i data-lucide="receipt"></i>Nenhuma venda registada no período.</div>';
  } else {
    const rows = list.map(inv => {
      const dt = new Date(inv.created_at);
      const when = dt.toLocaleDateString('pt-PT') + ' ' + dt.toLocaleTimeString('pt-PT', {hour:'2-digit', minute:'2-digit'});
      return '<tr data-report-invoice="' + escapeHtml(inv.__backendId) + '">' +
        '<td>' + when + '</td>' +
        '<td>' + escapeHtml(inv.invoice_number) + '</td>' +
        '<td>' + escapeHtml(inv.customer || 'Cliente balcão') + '</td>' +
        '<td class="num">' + invoiceUnits(inv) + '</td>' +
        '<td class="num">' + money(inv.total) + '</td>' +
      '</tr>';
    }).join('');

    $('report-table').innerHTML =
      '<table class="report-table"><thead><tr>' +
        '<th>Data / Hora</th><th>Nº Factura</th><th>Cliente</th>' +
        '<th class="num">Unidades</th><th class="num">Total</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  lucide.createIcons();
}

// Exporta o período atual para CSV
function exportReportCSV(){
  const list = invoicesInRange();
  if(!list.length){ notice('Sem vendas para exportar no período.', 'error'); return; }

  const header = ['Data','Hora','Numero Factura','Cliente','Artigos','Unidades','Total (MZN)'];
  const rows = list.map(inv => {
    const dt = new Date(inv.created_at);
    const dateStr = dt.toLocaleDateString('pt-PT');
    const timeStr = dt.toLocaleTimeString('pt-PT', {hour:'2-digit', minute:'2-digit'});
    let artigos = '';
    try{
      artigos = JSON.parse(inv.items_json || '[]')
        .map(x => x.name + ' x' + x.quantity)
        .join('; ');
    }catch(err){}
    return [dateStr, timeStr, inv.invoice_number, inv.customer || 'Cliente balcão',
            artigos, invoiceUnits(inv), Number(inv.total||0).toFixed(2)];
  });

  // Escapa campos que tenham vírgula/ponto-e-vírgula/aspas
  const esc = v => '"' + String(v).replace(/"/g,'""') + '"';
  const csv = [header.map(esc).join(';')]
    .concat(rows.map(r => r.map(esc).join(';')))
    .join('\r\n');

  const blob = new Blob(['\uFEFF' + csv], {type:'text/csv;charset=utf-8;'}); // BOM para Excel
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'vendas_' + (reportState.from || 'inicio') + '_a_' + (reportState.to || 'fim') + '.csv';
  a.click();
  URL.revokeObjectURL(url);
  notice('CSV exportado.', 'success');
}

// Eventos do relatório
$('report-apply').onclick = () => {
  reportState.from = $('report-from').value;
  reportState.to = $('report-to').value;
  reportState.preset = '';
  document.querySelectorAll('#report-presets .preset').forEach(b => b.classList.remove('active'));
  if(reportState.from && reportState.to && reportState.from > reportState.to){
    notice('A data inicial não pode ser posterior à final.', 'error');
    return;
  }
  renderReport();
};

$('report-presets').onclick = e => {
  const b = e.target.closest('.preset');
  if(b) applyPreset(b.dataset.preset);
};

$('report-from').onchange = () => { reportState.from = $('report-from').value; };
$('report-to').onchange   = () => { reportState.to   = $('report-to').value; };

$('report-table').onclick = e => {
  const tr = e.target.closest('[data-report-invoice]');
  if(!tr) return;
  const inv = records.find(x => x.__backendId === tr.dataset.reportInvoice);
  if(inv) showInvoicePaper(inv);
};

$('report-export').onclick = exportReportCSV;

/* ============================================================
   MESAS — render e operações
   ============================================================ */

// Total de uma mesa (soma dos pedidos)
function tableTotal(t){
  return (t.orders||[]).reduce((a,x) => a + Number(x.price)*Number(x.quantity), 0);
}
// Nº de unidades
function tableUnits(t){
  return (t.orders||[]).reduce((a,x) => a + Number(x.quantity), 0);
}

// Desenha a grelha de mesas + um "slot" para abrir nova
function renderTables(){
  if(!$('tables-grid')) return;
  const cards = tables.map(t => {
    const openedAt = new Date(t.opened_at);
    const since = openedAt.toLocaleDateString('pt-PT', {day:'2-digit', month:'short'}) + ' ' +
                  openedAt.toLocaleTimeString('pt-PT', {hour:'2-digit', minute:'2-digit'});
    const units = tableUnits(t);
    return '<div class="table-card" data-table-open="'+escapeHtml(t.id)+'">' +
      '<div class="tc-head">' +
        '<div>' +
          '<div class="tc-name">'+escapeHtml(t.name)+'</div>' +
          '<div class="tc-since">Aberta em '+since+'</div>' +
        '</div>' +
        '<span class="tc-badge">Aberta</span>' +
      '</div>' +
      '<div class="tc-total">'+money(tableTotal(t))+'</div>' +
      '<div class="tc-items">'+units+' '+(units===1?'artigo':'artigos')+' pedidos</div>' +
      '<div class="tc-actions">' +
        '<button class="button small" data-table-open="'+escapeHtml(t.id)+'"><i data-lucide="utensils"></i> Continuar</button>' +
      '</div>' +
    '</div>';
  }).join('');

  const slot = '<button class="table-card empty-slot" id="table-new-slot" type="button">' +
    '<i data-lucide="plus-circle"></i>Abrir nova mesa' +
  '</button>';

  $('tables-grid').innerHTML = cards + slot;
  lucide.createIcons();
}

// Abre o painel de detalhe de uma mesa
function openTableDetail(tableId){
  const t = tables.find(x => x.id === tableId);
  if(!t){ activeTableId = null; $('table-detail').style.display='none'; return; }
  activeTableId = tableId;
  $('table-detail').style.display = 'block';

  // Cabeçalho
  const openedAt = new Date(t.opened_at);
  $('table-head').innerHTML =
    '<div>' +
      '<div class="th-name">'+escapeHtml(t.name)+'</div>' +
      '<div class="th-meta">Aberta em '+openedAt.toLocaleString('pt-PT')+'</div>' +
    '</div>' +
    '<div class="th-total">'+money(tableTotal(t))+'</div>';

  // Contagem
  const units = tableUnits(t);
  $('table-order-count').textContent = units + (units===1 ? ' artigo' : ' artigos');

  // Linhas do pedido
  $('table-order').innerHTML = (t.orders && t.orders.length)
    ? t.orders.map((x,i) => '<div class="table-order-line">' +
        '<div class="to-name">'+escapeHtml(x.name)+'<small>'+money(x.price)+' / un.</small></div>' +
        '<div class="qty-controls">' +
          '<button data-table-qty="'+i+'" data-table-delta="-1" aria-label="Diminuir"><i data-lucide="minus"></i></button>' +
          '<span>'+x.quantity+'</span>' +
          '<button data-table-qty="'+i+'" data-table-delta="1" aria-label="Aumentar"><i data-lucide="plus"></i></button>' +
        '</div>' +
        '<div class="to-sub">'+money(x.price*x.quantity)+'</div>' +
        '<button class="icon-button" data-table-remove="'+i+'" aria-label="Remover"><i data-lucide="trash-2"></i></button>' +
      '</div>').join('')
    : '<div class="table-order-empty"><i data-lucide="clipboard-list"></i>Ainda sem pedidos.</div>';

  $('table-total').textContent = money(tableTotal(t));

  // Produtos disponíveis (filtro)
  renderTableResults();
  lucide.createIcons();
  setTimeout(() => $('table-barcode').focus(), 60);
}

// Grelha de produtos para adicionar ao pedido
function renderTableResults(){
  if(!$('table-results')) return;
  const q = ($('table-search').value || '').trim().toLowerCase();
  const list = products().filter(x => {
    if(!q) return true;
    return (x.name + ' ' + x.sku + ' ' + x.category).toLowerCase().includes(q);
  }).slice(0,40);

  $('table-results').innerHTML = list.length
    ? list.map(x => {
        const stock = Number(x.stock||0);
        // Stock disponível = stock atual − já pedido nesta mesa (para o mesmo produto)
        const t = tables.find(tt => tt.id === activeTableId);
        const inTable = t ? (t.orders.find(o => o.id === x.__backendId)?.quantity || 0) : 0;
        const available = stock - inTable;
        return '<button class="pos-card" data-table-add="'+escapeHtml(x.__backendId)+'" '+(available<=0?'disabled':'')+'>' +
          (x.image
            ? '<img src="'+escapeHtml(x.image)+'" alt="" '+
              'style="width:100%;height:70px;object-fit:cover;border-radius:8px;margin-bottom:4px">'
            : '')+
          '<span class="pc-name">'+escapeHtml(x.name)+'</span>' +
          '<span class="pc-meta">'+escapeHtml(x.sku)+' · '+escapeHtml(x.category)+'</span>' +
          '<span class="pc-price">'+money(x.price)+'</span>' +
          '<span class="pc-stock '+(available<5?'low':'')+'">'+(available>0?available+' disponíveis':'Sem stock')+'</span>' +
        '</button>';
      }).join('')
    : '<div class="empty"><i data-lucide="search-x"></i>Nenhum produto encontrado.</div>';
  lucide.createIcons();
}

// Adiciona um produto ao pedido da mesa ativa
function tableAddProduct(productId, qty=1){
  const t = tables.find(x => x.id === activeTableId);
  if(!t) return;
  const p = products().find(x => x.__backendId === productId);
  if(!p) return;

  // Quantidade já pedida nesta mesa para este produto
  const line = t.orders.find(o => o.id === p.__backendId);
  const inTable = line?.quantity || 0;
  if(inTable + qty > Number(p.stock)){
    notice('Stock insuficiente para "'+p.name+'". Disponível: '+(Number(p.stock) - inTable)+'.');
    return;
  }

  if(line) line.quantity += qty;
  else t.orders.push({id:p.__backendId, name:p.name, price:Number(p.price), quantity:qty});

  writeTables(tables);
  openTableDetail(activeTableId); // re-renderiza o painel
  $('status').className = 'status';
}

// Abre uma nova mesa: pede nome
function createTable(){
  const name = (prompt('Nome da mesa (ex.: "Mesa 3", "João", "Esplanada 2"):') || '').trim();
  if(!name) return;
  // Evita duplicados exatos (case-insensitive)
  if(tables.some(t => t.name.toLowerCase() === name.toLowerCase())){
    notice('Já existe uma mesa com esse nome.');
    return;
  }
  const t = {id:newTableId(), name, opened_at:new Date().toISOString(), orders:[]};
  tables.push(t);
  writeTables(tables);
  renderTables();
  openTableDetail(t.id);
  notice('Mesa "'+name+'" aberta.', 'success');
}

// Fecha a conta: cria factura, abate stock, imprime, remove a mesa
async function closeTable(){
  const t = tables.find(x => x.id === activeTableId);
  if(!t) return;
  if(!t.orders || !t.orders.length){
    notice('A mesa não tem pedidos. Adicione artigos ou cancele a mesa.');
    return;
  }
  if(!confirm('Fechar a conta de "'+t.name+'" e imprimir o recibo?')) return;

  // Valida stock atual
  for(const line of t.orders){
    const p = products().find(x => x.__backendId === line.id);
    if(!p || Number(p.stock) < line.quantity){
      notice('Stock insuficiente para "'+line.name+'" (tem '+ (p?.stock||0) +'). Ajuste os pedidos.');
      return;
    }
  }

  busy = true;
  $('table-close').disabled = true;
  $('table-close').textContent = 'A fechar…';

  const lines = t.orders.map(x => ({...x}));
  const invoice = {
    record_type:'invoice',
    ...blank,
    customer: t.name,
    items_json: JSON.stringify(lines.map(({name,price,quantity}) => ({name,price,quantity}))),
    total: lines.reduce((a,x) => a + x.price*x.quantity, 0),
    invoice_number: 'FT-'+Date.now().toString(36).toUpperCase(),
    created_at: new Date().toISOString()
  };

  try{
    const r = await window.dataSdk.create(invoice);
    if(!r.isOk){ notice('Não foi possível fechar a conta. Tente novamente.'); return; }

    // Abate stock
    let failed = false;
    for(const line of lines){
      const p = products().find(x => x.__backendId === line.id);
      if(!p){ failed = true; continue; }
      const updated = await window.dataSdk.update({...p, stock: Number(p.stock) - line.quantity});
      if(!updated.isOk) failed = true;
      else p.stock = Number(p.stock) - line.quantity;
    }

    // Remove a mesa
    tables = tables.filter(x => x.id !== t.id);
    writeTables(tables);
    activeTableId = null;
    $('table-detail').style.display = 'none';
    renderTables();
    render();

    notice(failed
      ? 'Conta fechada, mas não foi possível actualizar todo o stock.'
      : 'Conta fechada e stock atualizado.', failed ? 'error' : 'success');

    // Abre o talão para impressão
    const inv = records.find(x => x.__backendId === r.data?.__backendId);
    if(inv){
      showInvoicePaper(inv);
      // dispara impressão automaticamente após abrir o talão
      setTimeout(() => window.print(), 300);
    }
  }catch(err){
    notice('Ocorreu um erro ao fechar a conta.');
  }finally{
    busy = false;
    if($('table-close')){
      $('table-close').disabled = false;
      $('table-close').innerHTML = '<i data-lucide="receipt"></i> Fechar conta e imprimir';
      lucide.createIcons();
    }
  }
}

// Cancela a mesa sem criar factura
function cancelTable(){
  const t = tables.find(x => x.id === activeTableId);
  if(!t) return;
  if(!confirm('Cancelar a mesa "'+t.name+'"? Os pedidos serão perdidos.')) return;
  tables = tables.filter(x => x.id !== t.id);
  writeTables(tables);
  activeTableId = null;
  $('table-detail').style.display = 'none';
  renderTables();
  notice('Mesa cancelada.', 'success');
}

/* ============================================================
   MESAS — eventos
   ============================================================ */
const tableNewBtn = $('table-new');
if(tableNewBtn) tableNewBtn.onclick = createTable;

const tablesGrid = $('tables-grid');
if(tablesGrid){
  tablesGrid.onclick = e => {
    // Abrir nova mesa pelo slot
    if(e.target.closest('#table-new-slot')){ createTable(); return; }
    // Abrir mesa existente
    const card = e.target.closest('[data-table-open]');
    if(card){ openTableDetail(card.dataset.tableOpen); }
  };
}

const tableSearch = $('table-search');
if(tableSearch) tableSearch.oninput = renderTableResults;

const tableResults = $('table-results');
if(tableResults){
  tableResults.onclick = e => {
    const b = e.target.closest('[data-table-add]');
    if(!b || b.disabled) return;
    tableAddProduct(b.dataset.tableAdd, 1);
  };
}

const tableBarcodeAdd = $('table-barcode-add');
if(tableBarcodeAdd){
  tableBarcodeAdd.onclick = () => {
    const code = $('table-barcode').value.trim();
    if(!code){ notice('Introduza um código de barras ou referência.'); return; }
    const c = code.toLowerCase();
    const p = products().find(x => String(x.sku||'').toLowerCase() === c);
    if(!p){ notice('Nenhum produto encontrado com o código "'+code+'".'); return; }
    tableAddProduct(p.__backendId, 1);
    $('table-barcode').value = '';
    $('table-barcode').focus();
  };
}

const tableBarcode = $('table-barcode');
if(tableBarcode){
  tableBarcode.addEventListener('keydown', e => {
    if(e.key === 'Enter'){ e.preventDefault(); tableBarcodeAdd && tableBarcodeAdd.click(); }
  });
}

const tableOrder = $('table-order');
if(tableOrder){
  tableOrder.onclick = e => {
    const qty = e.target.closest('[data-table-qty]');
    const rem = e.target.closest('[data-table-remove]');
    const t = tables.find(x => x.id === activeTableId);
    if(!t) return;

    if(qty){
      const i = Number(qty.dataset.tableQty);
      const delta = Number(qty.dataset.tableDelta);
      const line = t.orders[i];
      if(!line) return;
      const p = products().find(x => x.__backendId === line.id);
      const newQty = line.quantity + delta;
      if(newQty <= 0){
        t.orders.splice(i, 1);
      } else if(p && newQty > Number(p.stock)){
        notice('Stock insuficiente para "'+line.name+'".');
        return;
      } else {
        line.quantity = newQty;
      }
      writeTables(tables);
      openTableDetail(activeTableId);
      return;
    }
    if(rem){
      t.orders.splice(Number(rem.dataset.tableRemove), 1);
      writeTables(tables);
      openTableDetail(activeTableId);
    }
  };
}

const tableCloseBtn = $('table-close');
if(tableCloseBtn) tableCloseBtn.onclick = closeTable;

const tableCancelBtn = $('table-cancel');
if(tableCancelBtn) tableCancelBtn.onclick = cancelTable;

/* ============================================================
   INICIALIZAÇÃO
   ============================================================ */

// Data de hoje no cabeçalho
$('today-label').textContent = new Intl.DateTimeFormat('pt-PT', {
  day:'numeric', month:'long', year:'numeric'
}).format(new Date());

// Cria os ícones Lucide iniciais
lucide.createIcons();

// Carrega as mesas guardadas no localStorage
tables = readTables();
if(activeTableId && !tables.some(t => t.id === activeTableId)) activeTableId = null;

// Pré-configura o período do relatório ("Hoje")
(function initReportDefaults(){
  const t = todayISO();
  reportState.from = t;
  reportState.to = t;
  $('report-from').value = t;
  $('report-to').value = t;
  document.querySelectorAll('#report-presets .preset').forEach(b => {
    b.classList.toggle('active', b.dataset.preset === 'today');
  });
})();

// Liga-se ao dataSdk local (localStorage) e renderiza
(async () => {
  try{
    const result = await window.dataSdk.init({
      onDataChanged(data){ records = data; render(); }
    });
    if(!result.isOk){
      notice('Não foi possível ligar os dados. Recarregue a página.');
      return;
    }
    ready = true;
    render();
  }catch(err){
    notice('Não foi possível ligar os dados. Recarregue a página.');
  }
})();
