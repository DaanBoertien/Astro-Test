(function () {
  'use strict';

  const HASH_TRIGGER = '#cms';
  let identity = null;
  let editMode = false;
  let currentLocale = 'en';
  let siteData = null;
  let allPagesData = {};   // { "home": {...}, "bio": {...} }
  let concertsData = null;
  let pendingChanges = {}; // Same structure, modified by edits
  let pendingSiteChanges = null;
  let pendingConcertsChanges = null;
  let sidebarOpen = false;
  let dirty = false;

  // ── Bootstrap ──────────────────────────────────────────────
  function init() {
    identity = window.netlifyIdentity;
    if (!identity) return;

    if (window.location.hash === HASH_TRIGGER) {
      const user = identity.currentUser();
      if (user) {
        activateEditMode(user);
      } else {
        identity.open('login');
        identity.on('login', function onLogin(user) {
          identity.off('login', onLogin);
          identity.close();
          activateEditMode(user);
        });
      }
    }
  }

  // ── Activate Edit Mode ─────────────────────────────────────
  async function activateEditMode(user) {
    editMode = true;
    document.body.classList.add('cms-edit-mode');

    // Load data
    try {
      siteData = await fetchJson('/data/site.json');
      concertsData = await fetchJson('/data/concerts.json');
      pendingSiteChanges = structuredClone(siteData);
      pendingConcertsChanges = structuredClone(concertsData);
      currentLocale = siteData.defaultLocale;

      // Load all page files
      const pageFiles = ['home', 'bio', 'concerts', 'contact'];
      for (const name of pageFiles) {
        try {
          const data = await fetchJson('/data/pages/' + name + '.json');
          allPagesData[name] = data;
          pendingChanges[name] = structuredClone(data);
        } catch (e) { /* page may not exist */ }
      }
    } catch (e) {
      showToast('Failed to load CMS data: ' + e.message, 'error');
      return;
    }

    initEditableElements();
    injectToolbar(user);
    injectSidebar();

    window.addEventListener('beforeunload', function (e) {
      if (dirty) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  // ── Initialize Editable Elements ───────────────────────────
  function initEditableElements() {
    document.querySelectorAll('[data-cms-field]').forEach(function (el) {
      var type = el.dataset.cmsType || 'text';
      el.classList.add('cms-editable');

      if (type === 'text' || type === 'textarea') {
        initTextEditable(el);
      } else if (type === 'image') {
        initImageEditable(el);
      } else if (type === 'background-image') {
        initBgImageEditable(el);
      } else if (type === 'date') {
        initTextEditable(el);
      }
    });

    // List containers
    document.querySelectorAll('[data-cms-type="list"]').forEach(function (el) {
      initListEditable(el);
    });

    // Concert list containers
    document.querySelectorAll('[data-cms-type="concert-list"]').forEach(function (el) {
      initConcertListEditable(el);
    });
  }

  // ── Text Editing ───────────────────────────────────────────
  function initTextEditable(el) {
    el.setAttribute('contenteditable', 'true');
    el.addEventListener('input', function () {
      var file = el.dataset.cmsFile;
      var section = el.dataset.cmsSection;
      var field = el.dataset.cmsField;
      var value = el.innerText.trim();

      if (file === 'concerts') {
        setNestedValue(pendingConcertsChanges, field, value);
      } else if (section) {
        setTranslatableField(file, section, field, value, currentLocale);
      }
      markDirty();
    });
  }

  // ── Image Editing ──────────────────────────────────────────
  function initImageEditable(el) {
    el.style.cursor = 'pointer';
    el.addEventListener('click', function (e) {
      if (!editMode) return;
      e.preventDefault();
      showImageEditor(el, function (url) {
        el.src = url;
        var file = el.dataset.cmsFile;
        var section = el.dataset.cmsSection;
        var field = el.dataset.cmsField;
        setSectionContentField(file, section, field, url);
        markDirty();
      });
    });
  }

  function initBgImageEditable(el) {
    el.addEventListener('click', function (e) {
      if (!editMode || e.target !== el) return;
      var currentUrl = el.style.backgroundImage.replace(/url\(['"]?|['"]?\)/g, '');
      showImageEditor(el, function (url) {
        el.style.backgroundImage = "url('" + url + "')";
        var file = el.dataset.cmsFile;
        var section = el.dataset.cmsSection;
        var field = el.dataset.cmsField;
        setSectionContentField(file, section, field, url);
        markDirty();
      }, currentUrl);
    });
  }

  function showImageEditor(anchorEl, onApply, currentUrl) {
    closeImageEditor();
    var url = currentUrl || (anchorEl.src || '');
    var editor = document.createElement('div');
    editor.className = 'cms-image-editor';
    editor.id = 'cms-active-image-editor';
    editor.innerHTML =
      '<input type="url" value="' + escapeAttr(url) + '" placeholder="Image URL" />' +
      '<button>Apply</button>';

    var rect = anchorEl.getBoundingClientRect();
    editor.style.top = Math.min(rect.bottom + 8, window.innerHeight - 60) + 'px';
    editor.style.left = Math.max(8, rect.left) + 'px';
    document.body.appendChild(editor);

    editor.querySelector('button').addEventListener('click', function () {
      onApply(editor.querySelector('input').value);
      editor.remove();
    });

    setTimeout(function () {
      document.addEventListener('click', function closeOnOutside(e) {
        if (!editor.contains(e.target) && e.target !== anchorEl) {
          editor.remove();
          document.removeEventListener('click', closeOnOutside);
        }
      });
    }, 100);
  }

  function closeImageEditor() {
    var existing = document.getElementById('cms-active-image-editor');
    if (existing) existing.remove();
  }

  // ── List Editing (awards etc.) ─────────────────────────────
  function initListEditable(container) {
    var addBtn = document.createElement('button');
    addBtn.className = 'cms-list-add';
    addBtn.textContent = '+ Add item';
    container.appendChild(addBtn);

    // Delete buttons on existing items
    container.querySelectorAll(':scope > [data-cms-field]').forEach(function (item) {
      addItemDeleteBtn(item);
    });

    addBtn.addEventListener('click', function () {
      var file = container.dataset.cmsFile;
      var section = container.dataset.cmsSection;
      var field = container.dataset.cmsField;
      var pageData = pendingChanges[file.replace('pages/', '')];
      if (!pageData) return;

      var sec = pageData.sections.find(function (s) { return s.id === section; });
      if (!sec) return;

      var items = sec.content[field];
      if (!items) return;

      var newItem = {};
      siteData.locales.forEach(function (loc) { newItem[loc] = 'New item'; });
      items.push(newItem);
      markDirty();
      showToast('Item added. Save to see it rendered.');
    });
  }

  function addItemDeleteBtn(el) {
    var btn = document.createElement('button');
    btn.className = 'cms-item-delete';
    btn.textContent = '\u00d7';
    btn.title = 'Delete item';
    btn.addEventListener('click', function () {
      var file = el.dataset.cmsFile;
      var section = el.dataset.cmsSection;
      var field = el.dataset.cmsField; // e.g. "items.2"
      var parts = field.split('.');
      var arrayField = parts[0];
      var index = parseInt(parts[1]);

      var pageData = pendingChanges[file.replace('pages/', '')];
      if (!pageData) return;

      var sec = pageData.sections.find(function (s) { return s.id === section; });
      if (!sec || !sec.content[arrayField]) return;

      sec.content[arrayField].splice(index, 1);
      el.remove();
      markDirty();
      showToast('Item removed. Save to update.');
    });
    el.appendChild(btn);
  }

  // ── Concert List Editing ───────────────────────────────────
  function initConcertListEditable(container) {
    // Add delete buttons to each concert row
    container.querySelectorAll('.concert-row').forEach(function (row) {
      var idx = row.dataset.cmsConcertIndex;
      if (idx === undefined) return;
      var btn = document.createElement('button');
      btn.className = 'cms-concert-delete';
      btn.textContent = '\u00d7';
      btn.title = 'Delete concert';
      btn.addEventListener('click', function () {
        var i = parseInt(idx);
        pendingConcertsChanges.concerts.splice(i, 1);
        row.remove();
        markDirty();
        showToast('Concert removed. Save to update.');
      });
      row.appendChild(btn);
    });

    // Add concert button
    var addBtn = document.createElement('button');
    addBtn.className = 'cms-list-add';
    addBtn.textContent = '+ Add concert';
    container.appendChild(addBtn);

    addBtn.addEventListener('click', function () {
      pendingConcertsChanges.concerts.push({
        date: new Date().toISOString().slice(0, 10),
        venue: 'New Venue',
        city: 'City',
        program: 'Program'
      });
      markDirty();
      showToast('Concert added. Save and reload to see it.');
    });
  }

  // ── Toolbar ────────────────────────────────────────────────
  function injectToolbar(user) {
    var toolbar = document.createElement('div');
    toolbar.id = 'cms-toolbar';
    toolbar.innerHTML =
      '<span class="cms-toolbar-label">' + escapeHtml(user.email) + '</span>' +
      '<button id="cms-sidebar-toggle">Panels</button>' +
      '<span class="cms-toolbar-status" id="cms-status">No changes</span>' +
      '<button id="cms-save" disabled>Save</button>' +
      '<button id="cms-logout">Log out</button>';
    document.body.appendChild(toolbar);

    document.getElementById('cms-save').addEventListener('click', save);
    document.getElementById('cms-logout').addEventListener('click', function () {
      identity.logout();
      window.location.hash = '';
      window.location.reload();
    });
    document.getElementById('cms-sidebar-toggle').addEventListener('click', toggleSidebar);
  }

  function markDirty() {
    dirty = true;
    var status = document.getElementById('cms-status');
    var saveBtn = document.getElementById('cms-save');
    if (status) { status.textContent = 'Unsaved changes'; status.classList.add('cms-dirty'); }
    if (saveBtn) saveBtn.disabled = false;
  }

  // ── Sidebar ────────────────────────────────────────────────
  function injectSidebar() {
    var sidebar = document.createElement('div');
    sidebar.id = 'cms-sidebar';
    sidebar.innerHTML = buildSidebarHTML();
    document.body.appendChild(sidebar);

    bindSidebarEvents();
  }

  function buildSidebarHTML() {
    var html = '';

    // Language section
    html += '<div class="cms-sidebar-section"><h3>Language</h3><div class="cms-lang-tabs">';
    siteData.locales.forEach(function (loc) {
      var active = loc === currentLocale ? ' active' : '';
      var label = siteData.localeNames[loc] || loc.toUpperCase();
      html += '<button class="cms-lang-tab' + active + '" data-locale="' + loc + '">' + escapeHtml(label) + '</button>';
    });
    html += '</div></div>';

    // Pages section
    html += '<div class="cms-sidebar-section"><h3>Pages</h3><ul class="cms-page-list">';
    var currentSlug = getCurrentPageSlug();
    Object.keys(pendingChanges).forEach(function (key) {
      var page = pendingChanges[key];
      var active = (key === currentSlug || (key === 'home' && currentSlug === '')) ? ' active' : '';
      var title = getLocalizedValue(page.title, currentLocale) || key;
      html += '<li class="cms-page-item' + active + '" data-page="' + key + '">' +
        '<span class="cms-page-item-label">' + escapeHtml(title) + '</span>' +
        '<span style="color:#666;font-size:0.7rem">/' + escapeHtml(page.slug) + '</span>' +
        (key !== 'home' ? '<button class="cms-page-delete" data-page="' + key + '" title="Delete page">\u00d7</button>' : '') +
        '</li>';
    });
    html += '</ul><button class="cms-add-btn" id="cms-add-page">+ Add page</button></div>';

    // Sections for current page
    var pageName = currentSlug === '' ? 'home' : currentSlug;
    var pageData = pendingChanges[pageName];
    if (pageData) {
      html += '<div class="cms-sidebar-section"><h3>Sections</h3><ul class="cms-section-list">';
      pageData.sections.forEach(function (sec, idx) {
        html += '<li class="cms-section-item" data-section-id="' + sec.id + '">' +
          '<span class="cms-section-item-type">' + escapeHtml(sec.type) + '</span>' +
          '<span class="cms-section-item-label">' + escapeHtml(sec.id) + '</span>' +
          '<span class="cms-section-controls">' +
          (idx > 0 ? '<button class="cms-section-up" data-idx="' + idx + '" title="Move up">\u2191</button>' : '') +
          (idx < pageData.sections.length - 1 ? '<button class="cms-section-down" data-idx="' + idx + '" title="Move down">\u2193</button>' : '') +
          '<button class="cms-section-delete" data-idx="' + idx + '" title="Delete">\u00d7</button>' +
          '</span></li>';
      });
      html += '</ul><button class="cms-add-btn" id="cms-add-section">+ Add section</button></div>';
    }

    return html;
  }

  function refreshSidebar() {
    var sidebar = document.getElementById('cms-sidebar');
    if (sidebar) {
      var wasOpen = sidebar.classList.contains('open');
      sidebar.innerHTML = buildSidebarHTML();
      if (wasOpen) sidebar.classList.add('open');
      bindSidebarEvents();
    }
  }

  function bindSidebarEvents() {
    // Language tabs
    document.querySelectorAll('.cms-lang-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        currentLocale = tab.dataset.locale;
        refreshSidebar();
        showToast('Editing in: ' + (siteData.localeNames[currentLocale] || currentLocale));
      });
    });

    // Page navigation
    document.querySelectorAll('.cms-page-item').forEach(function (item) {
      item.addEventListener('click', function (e) {
        if (e.target.classList.contains('cms-page-delete')) return;
        var page = pendingChanges[item.dataset.page];
        if (page) {
          var href = page.slug === '' ? '/' : '/' + page.slug;
          if (currentLocale !== siteData.defaultLocale) {
            href = '/' + currentLocale + (page.slug ? '/' + page.slug : '');
          }
          window.location.href = href + HASH_TRIGGER;
        }
      });
    });

    // Delete page
    document.querySelectorAll('.cms-page-delete').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var key = btn.dataset.page;
        if (confirm('Delete page "' + key + '"? This will be permanent after saving.')) {
          delete pendingChanges[key];
          markDirty();
          refreshSidebar();
          showToast('Page "' + key + '" marked for deletion.');
        }
      });
    });

    // Add page
    var addPageBtn = document.getElementById('cms-add-page');
    if (addPageBtn) {
      addPageBtn.addEventListener('click', function () { showAddPageModal(); });
    }

    // Section controls
    document.querySelectorAll('.cms-section-up').forEach(function (btn) {
      btn.addEventListener('click', function () { moveSection(parseInt(btn.dataset.idx), -1); });
    });

    document.querySelectorAll('.cms-section-down').forEach(function (btn) {
      btn.addEventListener('click', function () { moveSection(parseInt(btn.dataset.idx), 1); });
    });

    document.querySelectorAll('.cms-section-delete').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(btn.dataset.idx);
        var pageName = getCurrentPageSlug() === '' ? 'home' : getCurrentPageSlug();
        var pageData = pendingChanges[pageName];
        if (pageData && confirm('Delete this section?')) {
          pageData.sections.splice(idx, 1);
          markDirty();
          refreshSidebar();
          showToast('Section deleted. Save and reload to see changes.');
        }
      });
    });

    // Add section
    var addSectionBtn = document.getElementById('cms-add-section');
    if (addSectionBtn) {
      addSectionBtn.addEventListener('click', function () { showAddSectionModal(); });
    }
  }

  function toggleSidebar() {
    var sidebar = document.getElementById('cms-sidebar');
    if (sidebar) {
      sidebarOpen = !sidebarOpen;
      sidebar.classList.toggle('open', sidebarOpen);
    }
  }

  // ── Move Section ───────────────────────────────────────────
  function moveSection(idx, direction) {
    var pageName = getCurrentPageSlug() === '' ? 'home' : getCurrentPageSlug();
    var pageData = pendingChanges[pageName];
    if (!pageData) return;
    var newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= pageData.sections.length) return;
    var temp = pageData.sections[idx];
    pageData.sections[idx] = pageData.sections[newIdx];
    pageData.sections[newIdx] = temp;
    markDirty();
    refreshSidebar();
    showToast('Section reordered. Save and reload to see changes.');
  }

  // ── Add Page Modal ─────────────────────────────────────────
  function showAddPageModal() {
    var overlay = document.createElement('div');
    overlay.className = 'cms-modal-overlay';
    overlay.innerHTML =
      '<div class="cms-modal">' +
        '<h3>Add New Page</h3>' +
        '<input class="cms-modal-input" id="cms-new-page-title" placeholder="Page title" />' +
        '<input class="cms-modal-input" id="cms-new-page-slug" placeholder="URL slug (e.g. gallery)" />' +
        '<button class="cms-modal-option" id="cms-new-page-submit" style="width:100%">Create Page</button>' +
        '<button class="cms-modal-cancel" id="cms-new-page-cancel">Cancel</button>' +
      '</div>';
    document.body.appendChild(overlay);

    document.getElementById('cms-new-page-cancel').addEventListener('click', function () { overlay.remove(); });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });

    document.getElementById('cms-new-page-submit').addEventListener('click', function () {
      var title = document.getElementById('cms-new-page-title').value.trim();
      var slug = document.getElementById('cms-new-page-slug').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
      if (!title || !slug) { showToast('Title and slug are required.', 'error'); return; }
      if (pendingChanges[slug]) { showToast('A page with that slug already exists.', 'error'); return; }

      var titleObj = {};
      siteData.locales.forEach(function (loc) { titleObj[loc] = title; });

      var maxOrder = 0;
      Object.values(pendingChanges).forEach(function (p) {
        if (p.navOrder > maxOrder) maxOrder = p.navOrder;
      });

      pendingChanges[slug] = {
        slug: slug,
        title: titleObj,
        showInNav: true,
        navOrder: maxOrder + 1,
        sections: []
      };

      markDirty();
      refreshSidebar();
      overlay.remove();
      showToast('Page "' + title + '" created. Add sections and save.');
    });
  }

  // ── Add Section Modal ──────────────────────────────────────
  function showAddSectionModal() {
    var types = [
      { type: 'hero', label: 'Hero Banner' },
      { type: 'text', label: 'Text Block' },
      { type: 'text-image', label: 'Text + Image' },
      { type: 'concert-list', label: 'Concert List' },
      { type: 'contact-form', label: 'Contact Form' },
      { type: 'cta', label: 'Call to Action' },
      { type: 'list', label: 'List / Awards' },
    ];

    var overlay = document.createElement('div');
    overlay.className = 'cms-modal-overlay';
    var html = '<div class="cms-modal"><h3>Add Section</h3><div class="cms-modal-grid">';
    types.forEach(function (t) {
      html += '<button class="cms-modal-option" data-type="' + t.type + '">' + escapeHtml(t.label) + '</button>';
    });
    html += '</div><button class="cms-modal-cancel" id="cms-section-modal-cancel">Cancel</button></div>';
    overlay.innerHTML = html;
    document.body.appendChild(overlay);

    document.getElementById('cms-section-modal-cancel').addEventListener('click', function () { overlay.remove(); });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });

    overlay.querySelectorAll('.cms-modal-option').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var type = btn.dataset.type;
        addSection(type);
        overlay.remove();
      });
    });
  }

  function addSection(type) {
    var pageName = getCurrentPageSlug() === '' ? 'home' : getCurrentPageSlug();
    var pageData = pendingChanges[pageName];
    if (!pageData) return;

    var id = type + '-' + Date.now();
    var content = getDefaultContent(type);

    pageData.sections.push({ id: id, type: type, content: content });
    markDirty();
    refreshSidebar();
    showToast('Section added. Save and reload to see it.');
  }

  function getDefaultContent(type) {
    var locales = siteData.locales;
    var makeTranslatable = function (val) {
      var obj = {};
      locales.forEach(function (loc) { obj[loc] = val; });
      return obj;
    };

    switch (type) {
      case 'hero':
        return { title: makeTranslatable('Heading'), subtitle: makeTranslatable('Subtitle'), image: '' };
      case 'text':
        return { title: makeTranslatable(''), body: makeTranslatable('Your text here.') };
      case 'text-image':
        return { title: makeTranslatable(''), body: makeTranslatable('Your text here.'), image: '', imageAlt: makeTranslatable(''), imagePosition: 'left' };
      case 'concert-list':
        return { upcomingTitle: makeTranslatable('Upcoming'), pastTitle: makeTranslatable('Past Performances') };
      case 'contact-form':
        return { title: makeTranslatable('Contact'), introText: makeTranslatable('Get in touch.') };
      case 'cta':
        return { title: makeTranslatable('Title'), description: makeTranslatable('Description'), buttonText: makeTranslatable('Click'), buttonLink: '#' };
      case 'list':
        return { title: makeTranslatable('Title'), items: [makeTranslatable('Item 1')] };
      default:
        return {};
    }
  }

  // ── Save Flow ──────────────────────────────────────────────
  async function save() {
    if (!dirty) return;
    var status = document.getElementById('cms-status');
    var saveBtn = document.getElementById('cms-save');
    status.textContent = 'Saving...';
    status.classList.remove('cms-dirty');
    saveBtn.disabled = true;

    try {
      var token = await identity.currentUser().jwt();
      var files = {};

      // Check which files changed
      if (JSON.stringify(pendingSiteChanges) !== JSON.stringify(siteData)) {
        files['site'] = pendingSiteChanges;
      }
      if (JSON.stringify(pendingConcertsChanges) !== JSON.stringify(concertsData)) {
        files['concerts'] = pendingConcertsChanges;
      }

      Object.keys(pendingChanges).forEach(function (key) {
        // Always include — could be new page or modified
        files['pages/' + key] = pendingChanges[key];
      });

      // Check for deleted pages
      Object.keys(allPagesData).forEach(function (key) {
        if (!pendingChanges[key]) {
          files['pages/' + key] = null; // null = delete
        }
      });

      if (Object.keys(files).length === 0) {
        status.textContent = 'No changes';
        return;
      }

      var response = await fetch('/.netlify/functions/cms-save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
        },
        body: JSON.stringify({ files: files }),
      });

      if (!response.ok) {
        var err = await response.json();
        throw new Error(err.error || 'Save failed');
      }

      // Update originals
      siteData = structuredClone(pendingSiteChanges);
      concertsData = structuredClone(pendingConcertsChanges);
      allPagesData = structuredClone(pendingChanges);

      dirty = false;
      status.textContent = 'Saved! Rebuilding...';
      saveBtn.disabled = true;
      showToast('Changes saved! Site will rebuild in ~30 seconds.', 'success');
    } catch (e) {
      status.textContent = 'Save failed!';
      status.classList.add('cms-dirty');
      saveBtn.disabled = false;
      showToast('Error: ' + e.message, 'error');
    }
  }

  // ── Helpers ────────────────────────────────────────────────
  async function fetchJson(url) {
    var resp = await fetch(url);
    if (!resp.ok) throw new Error('Failed to fetch ' + url);
    return resp.json();
  }

  function setNestedValue(obj, path, value) {
    var keys = path.split('.');
    var current = obj;
    for (var i = 0; i < keys.length - 1; i++) {
      var key = isNaN(keys[i]) ? keys[i] : parseInt(keys[i]);
      current = current[key];
    }
    var lastKey = isNaN(keys[keys.length - 1]) ? keys[keys.length - 1] : parseInt(keys[keys.length - 1]);
    current[lastKey] = value;
  }

  function getLocalizedValue(field, locale) {
    if (!field) return '';
    if (typeof field === 'string') return field;
    return field[locale] || field[siteData.defaultLocale] || '';
  }

  function setTranslatableField(file, sectionId, field, value, locale) {
    var pageName = file.replace('pages/', '');
    var pageData = pendingChanges[pageName];
    if (!pageData) return;
    var section = pageData.sections.find(function (s) { return s.id === sectionId; });
    if (!section) return;

    // Handle nested fields like "items.2"
    var parts = field.split('.');
    var target = section.content;
    for (var i = 0; i < parts.length - 1; i++) {
      var k = isNaN(parts[i]) ? parts[i] : parseInt(parts[i]);
      target = target[k];
    }
    var lastKey = isNaN(parts[parts.length - 1]) ? parts[parts.length - 1] : parseInt(parts[parts.length - 1]);
    var current = target[lastKey];

    if (current && typeof current === 'object' && !Array.isArray(current)) {
      current[locale] = value;
    } else {
      target[lastKey] = value;
    }
  }

  function setSectionContentField(file, sectionId, field, value) {
    var pageName = file.replace('pages/', '');
    var pageData = pendingChanges[pageName];
    if (!pageData) return;
    var section = pageData.sections.find(function (s) { return s.id === sectionId; });
    if (!section) return;
    section.content[field] = value;
  }

  function getCurrentPageSlug() {
    var path = window.location.pathname.replace(/\/$/, '');
    // Strip locale prefix if not default
    if (currentLocale !== siteData.defaultLocale) {
      path = path.replace(new RegExp('^/' + currentLocale), '');
    }
    path = path.replace(/^\//, '');
    return path;
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function showToast(message, type) {
    var toast = document.createElement('div');
    toast.className = 'cms-toast' + (type ? ' cms-toast-' + type : '');
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(function () { toast.remove(); }, 4000);
  }

  // ── Init ───────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
