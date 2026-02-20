(function () {
  'use strict';

  const HASH_TRIGGER = '#cms';
  let cmsPassword = null;
  let editMode = false;
  let currentLocale = 'en';
  let siteData = null;
  let allPagesData = {};
  let concertsData = null;
  let pendingChanges = {};
  let pendingSiteChanges = null;
  let pendingConcertsChanges = null;
  let sidebarOpen = false;
  let dirty = false;

  const AVAILABLE_LOCALES = {
    en: 'English', nl: 'Nederlands', de: 'Deutsch',
    fr: 'Français', es: 'Español', it: 'Italiano', pt: 'Português'
  };

  // ── Bootstrap ──────────────────────────────────────────────
  function init() {
    if (window.location.hash !== HASH_TRIGGER) return;

    // Check for saved session
    cmsPassword = sessionStorage.getItem('cms_password');
    if (cmsPassword) {
      activateEditMode();
    } else {
      showLoginPrompt();
    }
  }

  // ── Login Prompt ───────────────────────────────────────────
  function showLoginPrompt() {
    var overlay = document.createElement('div');
    overlay.className = 'cms-modal-overlay';
    overlay.innerHTML =
      '<div class="cms-modal">' +
        '<h3>CMS Login</h3>' +
        '<input class="cms-modal-input" id="cms-login-password" type="password" placeholder="Password" />' +
        '<button class="cms-modal-option" id="cms-login-submit" style="width:100%">Log in</button>' +
        '<button class="cms-modal-cancel" id="cms-login-cancel">Cancel</button>' +
      '</div>';
    document.body.appendChild(overlay);

    var passwordInput = document.getElementById('cms-login-password');
    var submitBtn = document.getElementById('cms-login-submit');

    passwordInput.focus();

    function doLogin() {
      var pw = passwordInput.value;
      if (!pw) return;
      cmsPassword = pw;
      sessionStorage.setItem('cms_password', pw);
      overlay.remove();
      activateEditMode();
    }

    submitBtn.addEventListener('click', doLogin);
    passwordInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doLogin();
    });

    document.getElementById('cms-login-cancel').addEventListener('click', function () {
      overlay.remove();
      window.location.hash = '';
    });
  }

  // ── Activate Edit Mode ─────────────────────────────────────
  async function activateEditMode() {
    editMode = true;
    document.body.classList.add('cms-edit-mode');

    try {
      siteData = await fetchJson('/data/site.json');
      concertsData = await fetchJson('/data/concerts.json');
      pendingSiteChanges = structuredClone(siteData);
      pendingConcertsChanges = structuredClone(concertsData);
      currentLocale = siteData.defaultLocale;

      // Dynamically discover pages via manifest (fallback to known pages)
      var pageFiles;
      try {
        pageFiles = await fetchJson('/data/pages-manifest.json');
      } catch (e) {
        pageFiles = ['home', 'bio', 'concerts', 'contact'];
      }

      for (var i = 0; i < pageFiles.length; i++) {
        try {
          var data = await fetchJson('/data/pages/' + pageFiles[i] + '.json');
          allPagesData[pageFiles[i]] = data;
          pendingChanges[pageFiles[i]] = structuredClone(data);
        } catch (e) { /* page may not exist */ }
      }
    } catch (e) {
      showToast('Failed to load CMS data: ' + e.message, 'error');
      return;
    }

    initEditableElements();
    injectToolbar();
    injectSidebar();

    window.addEventListener('beforeunload', function (e) {
      if (dirty) { e.preventDefault(); e.returnValue = ''; }
    });

    // Intercept all internal links to preserve #cms hash during navigation
    document.addEventListener('click', function (e) {
      var link = e.target.closest('a');
      if (!link || !editMode) return;
      var href = link.getAttribute('href');
      if (!href || href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('#')) return;
      // Internal link — append #cms so CMS re-activates on the new page
      e.preventDefault();
      window.location.href = href + HASH_TRIGGER;
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

    document.querySelectorAll('[data-cms-type="list"]').forEach(function (el) {
      initListEditable(el);
    });

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

    container.querySelectorAll(':scope > [data-cms-field]').forEach(function (item) {
      addItemDeleteBtn(item);
    });

    addBtn.addEventListener('click', function () {
      var file = container.dataset.cmsFile;
      var section = container.dataset.cmsSection;
      var field = container.dataset.cmsField;
      var pageName = file.replace('pages/', '');
      var pageData = pendingChanges[pageName];
      if (!pageData) return;

      var sec = pageData.sections.find(function (s) { return s.id === section; });
      if (!sec) return;

      var items = sec.content[field];
      if (!items) return;

      var newItem = {};
      siteData.locales.forEach(function (loc) { newItem[loc] = 'New item'; });
      items.push(newItem);

      // Render the new item in the DOM
      var newEl = document.createElement('li');
      newEl.textContent = 'New item';
      newEl.setAttribute('data-cms-file', file);
      newEl.setAttribute('data-cms-section', section);
      newEl.setAttribute('data-cms-field', field + '.' + (items.length - 1));
      newEl.classList.add('cms-editable');
      initTextEditable(newEl);
      addItemDeleteBtn(newEl);
      container.insertBefore(newEl, addBtn);

      markDirty();
      showToast('Item added.');
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
      var field = el.dataset.cmsField;
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

    var addBtn = document.createElement('button');
    addBtn.className = 'cms-list-add';
    addBtn.textContent = '+ Add concert';
    container.appendChild(addBtn);

    addBtn.addEventListener('click', function () {
      // Default to 1 month from now
      var futureDate = new Date();
      futureDate.setMonth(futureDate.getMonth() + 1);
      var dateStr = futureDate.toISOString().slice(0, 10);

      var newConcert = {
        date: dateStr,
        venue: 'Venue',
        city: 'City',
        program: 'Program'
      };
      var idx = pendingConcertsChanges.concerts.length;
      pendingConcertsChanges.concerts.push(newConcert);

      // Build row matching the real Astro-rendered structure
      var row = document.createElement('div');
      row.className = 'concert-row';
      row.dataset.cmsConcertIndex = idx;

      // Copy Astro scoped style attribute from an existing row
      var existingRow = container.querySelector('.concert-row');
      if (existingRow) {
        Array.from(existingRow.attributes).forEach(function (attr) {
          if (attr.name.startsWith('data-astro-cid')) {
            row.setAttribute(attr.name, attr.value);
          }
        });
      }

      var dateDiv = document.createElement('div');
      dateDiv.className = 'concert-date';
      dateDiv.setAttribute('data-cms-file', 'concerts');
      dateDiv.setAttribute('data-cms-field', 'concerts.' + idx + '.date');
      dateDiv.setAttribute('data-cms-type', 'date');
      dateDiv.textContent = formatDateForDisplay(dateStr);
      copyAstroCid(existingRow, dateDiv);

      var detailsDiv = document.createElement('div');
      detailsDiv.className = 'concert-details';
      copyAstroCid(existingRow, detailsDiv);

      var venueEl = document.createElement('strong');
      venueEl.setAttribute('data-cms-file', 'concerts');
      venueEl.setAttribute('data-cms-field', 'concerts.' + idx + '.venue');
      venueEl.setAttribute('data-cms-type', 'text');
      venueEl.textContent = newConcert.venue;
      copyAstroCid(existingRow, venueEl);

      var separator = document.createTextNode(' \u2014 ');

      var cityEl = document.createElement('span');
      cityEl.setAttribute('data-cms-file', 'concerts');
      cityEl.setAttribute('data-cms-field', 'concerts.' + idx + '.city');
      cityEl.setAttribute('data-cms-type', 'text');
      cityEl.textContent = newConcert.city;
      copyAstroCid(existingRow, cityEl);

      var programEl = document.createElement('span');
      programEl.className = 'concert-program';
      programEl.setAttribute('data-cms-file', 'concerts');
      programEl.setAttribute('data-cms-field', 'concerts.' + idx + '.program');
      programEl.setAttribute('data-cms-type', 'text');
      programEl.textContent = newConcert.program;
      copyAstroCid(existingRow, programEl);

      detailsDiv.appendChild(venueEl);
      detailsDiv.appendChild(separator);
      detailsDiv.appendChild(cityEl);
      detailsDiv.appendChild(programEl);
      row.appendChild(dateDiv);
      row.appendChild(detailsDiv);

      // Make all data-cms fields editable — use direct object reference instead of index
      row.querySelectorAll('[data-cms-field]').forEach(function (el) {
        el.classList.add('cms-editable');
        el.setAttribute('contenteditable', 'true');
        el.addEventListener('input', function () {
          var fieldName = el.dataset.cmsField.split('.').pop();
          newConcert[fieldName] = el.innerText.trim();
          markDirty();
        });
      });

      // Add delete button — use indexOf on the object reference for correct splice
      var delBtn = document.createElement('button');
      delBtn.className = 'cms-concert-delete';
      delBtn.textContent = '\u00d7';
      delBtn.title = 'Delete concert';
      delBtn.addEventListener('click', function () {
        var actualIdx = pendingConcertsChanges.concerts.indexOf(newConcert);
        if (actualIdx !== -1) pendingConcertsChanges.concerts.splice(actualIdx, 1);
        row.remove();
        markDirty();
        showToast('Concert removed.');
      });
      row.appendChild(delBtn);

      // Insert into the upcoming concert list (first .concert-list in this container)
      var upcomingList = container.closest('section')
        ? container
        : container.querySelector('.concert-list');
      if (!upcomingList) upcomingList = container;

      // Insert before the add button (which is inside the concert-list)
      upcomingList.insertBefore(row, addBtn);
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      markDirty();
      showToast('Concert added. Edit the fields, then save.');
    });
  }

  // ── Toolbar ────────────────────────────────────────────────
  function injectToolbar() {
    var toolbar = document.createElement('div');
    toolbar.id = 'cms-toolbar';
    toolbar.innerHTML =
      '<span class="cms-toolbar-label">CMS Editor</span>' +
      '<button id="cms-sidebar-toggle">Panels</button>' +
      '<span class="cms-toolbar-status" id="cms-status">No changes</span>' +
      '<button id="cms-save" disabled>Save</button>' +
      '<button id="cms-logout">Log out</button>';
    document.body.appendChild(toolbar);

    document.getElementById('cms-save').addEventListener('click', save);
    document.getElementById('cms-logout').addEventListener('click', function () {
      sessionStorage.removeItem('cms_password');
      cmsPassword = null;
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
    html += '<div class="cms-sidebar-section"><h3>Languages</h3><div class="cms-lang-tabs">';
    pendingSiteChanges.locales.forEach(function (loc) {
      var active = loc === currentLocale ? ' active' : '';
      var label = pendingSiteChanges.localeNames[loc] || AVAILABLE_LOCALES[loc] || loc.toUpperCase();
      html += '<button class="cms-lang-tab' + active + '" data-locale="' + loc + '">' + escapeHtml(label) + '</button>';
    });
    html += '</div>';
    html += '<button class="cms-add-btn" id="cms-manage-languages" style="margin-top:0.5rem">Manage languages</button>';
    html += '</div>';

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
    document.querySelectorAll('.cms-lang-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        currentLocale = tab.dataset.locale;
        refreshSidebar();
        showToast('Editing in: ' + (pendingSiteChanges.localeNames[currentLocale] || currentLocale));
      });
    });

    var manageLangBtn = document.getElementById('cms-manage-languages');
    if (manageLangBtn) {
      manageLangBtn.addEventListener('click', function () { showManageLanguagesModal(); });
    }

    document.querySelectorAll('.cms-page-item').forEach(function (item) {
      item.addEventListener('click', function (e) {
        if (e.target.classList.contains('cms-page-delete')) return;
        var page = pendingChanges[item.dataset.page];
        if (page) {
          var href = page.slug === '' ? '/' : '/' + page.slug;
          if (currentLocale !== pendingSiteChanges.defaultLocale) {
            href = '/' + currentLocale + (page.slug ? '/' + page.slug : '');
          }
          window.location.href = href + HASH_TRIGGER;
        }
      });
    });

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

    var addPageBtn = document.getElementById('cms-add-page');
    if (addPageBtn) {
      addPageBtn.addEventListener('click', function () { showAddPageModal(); });
    }

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
          var removed = pageData.sections.splice(idx, 1)[0];
          // Remove the section from the DOM if possible
          var domSection = document.querySelector('[data-cms-section-id="' + removed.id + '"]');
          if (domSection) domSection.remove();
          markDirty();
          refreshSidebar();
          showToast('Section deleted.');
        }
      });
    });

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

  // ── Manage Languages Modal ────────────────────────────────
  function showManageLanguagesModal() {
    var overlay = document.createElement('div');
    overlay.className = 'cms-modal-overlay';

    var currentLocales = pendingSiteChanges.locales.slice();
    var availableToAdd = Object.keys(AVAILABLE_LOCALES).filter(function (code) {
      return currentLocales.indexOf(code) === -1;
    });

    var html = '<div class="cms-modal"><h3>Manage Languages</h3>';

    // Active languages
    html += '<p style="color:#93b4ff;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:0.5rem">Active languages (' + currentLocales.length + '/3)</p>';
    currentLocales.forEach(function (code) {
      var isDefault = code === pendingSiteChanges.defaultLocale;
      html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:0.5rem 0.75rem;background:#2a2a3e;border-radius:4px;margin-bottom:0.35rem">' +
        '<span style="color:#eee">' + escapeHtml(AVAILABLE_LOCALES[code] || code) + ' (' + code + ')' + (isDefault ? ' — default' : '') + '</span>' +
        (isDefault ? '' : '<button class="cms-lang-remove" data-locale="' + code + '" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:0.9rem" title="Remove">\u00d7</button>') +
        '</div>';
    });

    // Add language (only show if under the limit)
    if (currentLocales.length < 3 && availableToAdd.length > 0) {
      html += '<p style="color:#888;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.5px;margin:1rem 0 0.5rem">Add a language</p>';
      html += '<select id="cms-lang-add-select" style="width:100%;padding:0.5rem;background:#2a2a3e;color:#eee;border:1px solid #444;border-radius:4px;font-family:inherit;margin-bottom:0.5rem">';
      html += '<option value="">Select a language...</option>';
      availableToAdd.forEach(function (code) {
        html += '<option value="' + code + '">' + escapeHtml(AVAILABLE_LOCALES[code]) + ' (' + code + ')</option>';
      });
      html += '</select>';
      html += '<button class="cms-modal-option" id="cms-lang-add-btn" style="width:100%">+ Add language</button>';
    } else if (currentLocales.length >= 3) {
      html += '<p style="color:#888;font-size:0.75rem;margin-top:1rem;font-style:italic">Maximum 3 languages reached. Remove one to add another.</p>';
    }

    html += '<button class="cms-modal-cancel" id="cms-lang-cancel" style="margin-top:1rem">Close</button></div>';

    overlay.innerHTML = html;
    document.body.appendChild(overlay);

    document.getElementById('cms-lang-cancel').addEventListener('click', function () { overlay.remove(); });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });

    // Add language button
    var addBtn = document.getElementById('cms-lang-add-btn');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        var select = document.getElementById('cms-lang-add-select');
        var code = select.value;
        if (!code) { showToast('Select a language first.', 'error'); return; }

        var defaultLoc = pendingSiteChanges.defaultLocale;
        pendingSiteChanges.locales.push(code);
        pendingSiteChanges.localeNames[code] = AVAILABLE_LOCALES[code] || code;

        // Add locale entries to all translatable fields
        Object.keys(pendingChanges).forEach(function (pageKey) {
          var page = pendingChanges[pageKey];
          if (page.title && typeof page.title === 'object' && !page.title[code]) {
            page.title[code] = page.title[defaultLoc] || '';
          }
          page.sections.forEach(function (sec) {
            addLocaleToContent(sec.content, code, defaultLoc);
          });
        });

        markDirty();
        refreshSidebar();
        overlay.remove();
        showToast(AVAILABLE_LOCALES[code] + ' added. Switch to it in the sidebar to edit translations.');
      });
    }

    // Remove language buttons
    overlay.querySelectorAll('.cms-lang-remove').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var code = btn.dataset.locale;
        if (!confirm('Remove ' + (AVAILABLE_LOCALES[code] || code) + '? Translations for this language will be lost on save.')) return;

        pendingSiteChanges.locales = pendingSiteChanges.locales.filter(function (l) { return l !== code; });
        delete pendingSiteChanges.localeNames[code];

        if (currentLocale === code) {
          currentLocale = pendingSiteChanges.defaultLocale;
        }

        markDirty();
        refreshSidebar();
        overlay.remove();
        showToast(AVAILABLE_LOCALES[code] + ' removed. Save to apply.');
      });
    });
  }

  function addLocaleToContent(content, locale, fallbackLocale) {
    if (!content || typeof content !== 'object') return;
    Object.keys(content).forEach(function (key) {
      var val = content[key];
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        // Check if it's a translatable field (has locale keys)
        if (val[fallbackLocale] !== undefined && val[locale] === undefined) {
          val[locale] = val[fallbackLocale];
        } else {
          addLocaleToContent(val, locale, fallbackLocale);
        }
      } else if (Array.isArray(val)) {
        val.forEach(function (item) {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            if (item[fallbackLocale] !== undefined && item[locale] === undefined) {
              item[locale] = item[fallbackLocale];
            }
          }
        });
      }
    });
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

    document.getElementById('cms-new-page-title').focus();

    document.getElementById('cms-new-page-cancel').addEventListener('click', function () { overlay.remove(); });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });

    document.getElementById('cms-new-page-submit').addEventListener('click', function () {
      var title = document.getElementById('cms-new-page-title').value.trim();
      var slug = document.getElementById('cms-new-page-slug').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
      if (!title || !slug) { showToast('Title and slug are required.', 'error'); return; }
      if (pendingChanges[slug]) { showToast('A page with that slug already exists.', 'error'); return; }

      var titleObj = {};
      pendingSiteChanges.locales.forEach(function (loc) { titleObj[loc] = title; });

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

      // Ensure sidebar is open so user sees the new page
      if (!sidebarOpen) toggleSidebar();

      showToast('Page "' + title + '" created! Add sections, then save. The page URL (/' + slug + ') will be live after the site rebuilds.');
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
        addSection(btn.dataset.type);
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

    // Render a visible placeholder section on the page
    renderSectionPlaceholder(id, type, content);

    markDirty();
    refreshSidebar();
    showToast('Section "' + type + '" added! You can edit text below. Save to finalize.');
  }

  function renderSectionPlaceholder(id, type, content) {
    var main = document.querySelector('main');
    if (!main) return;

    var section = document.createElement('section');
    section.className = 'cms-placeholder-section';
    section.setAttribute('data-cms-section-id', id);

    var label = document.createElement('div');
    label.className = 'cms-placeholder-label';
    label.textContent = type.toUpperCase() + ' section (new)';
    section.appendChild(label);

    // Render editable content based on type
    var pageName = getCurrentPageSlug() === '' ? 'home' : getCurrentPageSlug();
    var file = 'pages/' + pageName;

    if (content.title) {
      var h2 = document.createElement('h2');
      h2.textContent = getLocalizedValue(content.title, currentLocale) || 'Title';
      h2.setAttribute('contenteditable', 'true');
      h2.setAttribute('data-cms-file', file);
      h2.setAttribute('data-cms-section', id);
      h2.setAttribute('data-cms-field', 'title');
      h2.classList.add('cms-editable');
      initTextEditable(h2);
      section.appendChild(h2);
    }

    if (content.body) {
      var p = document.createElement('p');
      p.textContent = getLocalizedValue(content.body, currentLocale) || 'Your text here.';
      p.setAttribute('contenteditable', 'true');
      p.setAttribute('data-cms-file', file);
      p.setAttribute('data-cms-section', id);
      p.setAttribute('data-cms-field', 'body');
      p.classList.add('cms-editable');
      initTextEditable(p);
      section.appendChild(p);
    }

    if (content.subtitle) {
      var sub = document.createElement('p');
      sub.textContent = getLocalizedValue(content.subtitle, currentLocale) || 'Subtitle';
      sub.setAttribute('contenteditable', 'true');
      sub.setAttribute('data-cms-file', file);
      sub.setAttribute('data-cms-section', id);
      sub.setAttribute('data-cms-field', 'subtitle');
      sub.classList.add('cms-editable');
      initTextEditable(sub);
      section.appendChild(sub);
    }

    if (content.description) {
      var desc = document.createElement('p');
      desc.textContent = getLocalizedValue(content.description, currentLocale) || 'Description';
      desc.setAttribute('contenteditable', 'true');
      desc.setAttribute('data-cms-file', file);
      desc.setAttribute('data-cms-section', id);
      desc.setAttribute('data-cms-field', 'description');
      desc.classList.add('cms-editable');
      initTextEditable(desc);
      section.appendChild(desc);
    }

    var note = document.createElement('p');
    note.className = 'cms-placeholder-note';
    note.textContent = 'Full styling will appear after saving and rebuild.';
    section.appendChild(note);

    main.appendChild(section);
    section.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function getDefaultContent(type) {
    var locales = pendingSiteChanges.locales;
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
      var files = {};

      if (JSON.stringify(pendingSiteChanges) !== JSON.stringify(siteData)) {
        files['site'] = pendingSiteChanges;
      }
      if (JSON.stringify(pendingConcertsChanges) !== JSON.stringify(concertsData)) {
        files['concerts'] = pendingConcertsChanges;
      }

      Object.keys(pendingChanges).forEach(function (key) {
        files['pages/' + key] = pendingChanges[key];
      });

      Object.keys(allPagesData).forEach(function (key) {
        if (!pendingChanges[key]) {
          files['pages/' + key] = null;
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
          'Authorization': 'Bearer ' + cmsPassword,
        },
        body: JSON.stringify({ files: files }),
      });

      if (response.status === 401) {
        sessionStorage.removeItem('cms_password');
        showToast('Wrong password. Please log in again.', 'error');
        setTimeout(function () { window.location.reload(); }, 1500);
        return;
      }

      if (!response.ok) {
        var err = await response.json();
        throw new Error(err.error || 'Save failed');
      }

      siteData = structuredClone(pendingSiteChanges);
      concertsData = structuredClone(pendingConcertsChanges);
      allPagesData = structuredClone(pendingChanges);

      dirty = false;
      status.textContent = 'Saved! Rebuilding...';
      saveBtn.disabled = true;
      showToast('Changes saved! Site will rebuild in ~30 seconds. Reload to see full changes.', 'success');
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
      if (current[key] === undefined || current[key] === null) return;
      current = current[key];
    }
    var lastKey = isNaN(keys[keys.length - 1]) ? keys[keys.length - 1] : parseInt(keys[keys.length - 1]);
    current[lastKey] = value;
  }

  function getLocalizedValue(field, locale) {
    if (!field) return '';
    if (typeof field === 'string') return field;
    return field[locale] || field[pendingSiteChanges.defaultLocale] || '';
  }

  function setTranslatableField(file, sectionId, field, value, locale) {
    var pageName = file.replace('pages/', '');
    var pageData = pendingChanges[pageName];
    if (!pageData) return;
    var section = pageData.sections.find(function (s) { return s.id === sectionId; });
    if (!section) return;

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
    if (currentLocale !== pendingSiteChanges.defaultLocale) {
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

  function formatDateForDisplay(dateStr) {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric'
    });
  }

  function copyAstroCid(sourceEl, targetEl) {
    if (!sourceEl) return;
    Array.from(sourceEl.attributes).forEach(function (attr) {
      if (attr.name.startsWith('data-astro-cid')) {
        targetEl.setAttribute(attr.name, attr.value);
      }
    });
  }

  function showToast(message, type) {
    var toast = document.createElement('div');
    toast.className = 'cms-toast' + (type ? ' cms-toast-' + type : '');
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(function () { toast.remove(); }, 5000);
  }

  // ── Init ───────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
