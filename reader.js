/* Great Books reader: renders the markdown editions under books/ as a
   single-page app. Routes: #/ (library), #/<slug> (book index),
   #/<slug>/<chapter-file> (chapter). */
(function () {
  'use strict';

  var content = document.getElementById('content');
  var toc = document.getElementById('toc');
  var bookLabel = document.getElementById('book-label');

  var library = null;            // books/index.json
  var bookCache = {};            // slug -> book.json
  var mdCache = {};              // url -> markdown text

  marked.setOptions({ gfm: true });

  function fetchJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + ' -> ' + r.status);
      return r.json();
    });
  }
  function fetchMD(url) {
    if (mdCache[url]) return Promise.resolve(mdCache[url]);
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + ' -> ' + r.status);
      return r.text();
    }).then(function (t) { mdCache[url] = t; return t; });
  }

  function routePath(slug, file) {
    return '#/' + slug + (file ? '/' + file : '');
  }

  function fragmentHref(slug, file, id) {
    return routePath(slug, file) + '#' + encodeURIComponent(id);
  }

  function slugify(value) {
    var text = String(value).toLowerCase().trim();
    if (text.normalize) text = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    return text
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'section';
  }

  function addHeadingIds() {
    var used = {};
    var headings = [];
    content.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(function (heading) {
      var base = slugify(heading.textContent);
      var id = base;
      var suffix = 2;
      while (used[id]) id = base + '-' + suffix++;
      used[id] = true;
      heading.id = id;
      headings.push({
        element: heading,
        id: id,
        level: Number(heading.tagName.slice(1)),
        text: heading.textContent.trim()
      });
    });
    return headings;
  }

  function isNaturalBreak(heading) {
    // Paragraph-number headings in Locke are too numerous for inline
    // navigation. They still receive IDs, so they remain linkable.
    return heading.level >= 3 && !/^§\s*\d+/.test(heading.text);
  }

  function makeLink(slug, file, id, label, className) {
    var link = document.createElement('a');
    link.href = fragmentHref(slug, file, id);
    link.textContent = label;
    if (className) link.className = className;
    return link;
  }

  function addPageNavigation(slug, file, headings) {
    var links = headings.filter(function (heading) {
      return heading.level === 2 || isNaturalBreak(heading);
    });
    if (links.length === 0) return;

    var nav = document.createElement('nav');
    nav.id = 'page-navigation';
    nav.className = 'page-nav';
    nav.setAttribute('aria-label', 'On this page');

    var title = document.createElement('div');
    title.className = 'page-nav-title';
    title.textContent = 'On this page';
    nav.appendChild(title);

    var list = document.createElement('div');
    list.className = 'page-nav-links';
    links.forEach(function (heading) {
      var className = 'page-nav-link' + (heading.level >= 3 ? ' page-nav-sub' : '');
      list.appendChild(makeLink(slug, file, heading.id, heading.text, className));
    });
    nav.appendChild(list);

    var firstHeading = content.querySelector('h1');
    if (firstHeading) firstHeading.insertAdjacentElement('afterend', nav);
    else content.insertAdjacentElement('afterbegin', nav);
  }

  function addSectionPagers(slug, file, headings) {
    var breaks = headings.filter(isNaturalBreak);
    if (breaks.length < 2) return;

    breaks.forEach(function (heading, index) {
      var pager = document.createElement('nav');
      pager.className = 'section-pager';
      pager.setAttribute('aria-label', 'Section navigation');

      if (index > 0) {
        pager.appendChild(makeLink(slug, file, breaks[index - 1].id,
          '← ' + breaks[index - 1].text, 'section-pager-link'));
      } else {
        pager.appendChild(document.createElement('span'));
      }

      pager.appendChild(makeLink(slug, file, 'page-navigation', 'On this page', 'section-pager-top'));

      if (index < breaks.length - 1) {
        pager.appendChild(makeLink(slug, file, breaks[index + 1].id,
          breaks[index + 1].text + ' →', 'section-pager-link section-pager-next'));
      } else {
        pager.appendChild(document.createElement('span'));
      }

      var next = heading.element.nextElementSibling;
      var insertBefore = null;
      while (next) {
        if (/^H[1-6]$/.test(next.tagName) &&
            Number(next.tagName.slice(1)) <= heading.level) {
          insertBefore = next;
          break;
        }
        next = next.nextElementSibling;
      }
      if (insertBefore) content.insertBefore(pager, insertBefore);
      else content.appendChild(pager);
    });
  }

  function decorateContent(slug, file) {
    var headings = addHeadingIds();
    addPageNavigation(slug, file, headings);
    addSectionPagers(slug, file, headings);
  }

  function scrollToFragment(fragment) {
    if (!fragment) {
      window.scrollTo(0, 0);
      return;
    }
    var id;
    try { id = decodeURIComponent(fragment); } catch (e) { id = fragment; }
    var target = document.getElementById(id);
    if (target) target.scrollIntoView();
    else window.scrollTo(0, 0);
  }

  function stripFrontMatter(md) {
    var match = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
    return match ? md.slice(match[0].length) : md;
  }

  function getBook(slug) {
    if (bookCache[slug]) return Promise.resolve(bookCache[slug]);
    var entry = library.books.find(function (b) { return b.slug === slug; });
    if (!entry) return Promise.reject(new Error('Unknown book: ' + slug));
    return fetchJSON(entry.path + '/book.json').then(function (b) {
      b._path = entry.path;
      bookCache[slug] = b;
      return b;
    });
  }

  /* Rewrite relative .md links in rendered content to hash routes.
     baseIsReadme: links came from the book README (chapter links look like
     "chapters/xx.md"); otherwise from a chapter ("sibling.md", "../README.md"). */
  function rewriteLinks(slug, book, baseIsReadme, currentFile) {
    content.querySelectorAll('a[href]').forEach(function (a) {
      var href = a.getAttribute('href');
      if (/^(https?:|mailto:)/.test(href)) return;
      if (href.charAt(0) === '#') {
        a.setAttribute('href', routePath(slug, currentFile) + href);
        return;
      }
      var m;
      if ((m = href.match(/^(?:\.\/)?chapters\/([^\/]+\.md)$/))) {
        a.setAttribute('href', '#/' + slug + '/' + m[1]);
      } else if (href === '../README.md' || href === 'README.md' || href === './README.md') {
        a.setAttribute('href', '#/' + slug);
      } else if ((m = href.match(/^(?:\.\/)?([^\/]+\.md)$/)) && !baseIsReadme) {
        a.setAttribute('href', '#/' + slug + '/' + m[1]);
      } else {
        // real files (source texts, book.json): point at the actual path
        var base = book._path + (baseIsReadme ? '/' : '/chapters/');
        a.setAttribute('href', base + href);
      }
    });
  }

  function setTOC(html) { toc.innerHTML = html; }

  function renderLibrary() {
    document.title = 'Great Books — Modern English Library';
    bookLabel.textContent = '';
    setTOC(library.books.map(function (b) {
      return '<a href="#/' + b.slug + '">' + b.title + '</a>';
    }).join(''));
    content.innerHTML =
      '<h1>Great Books — Modern English Library</h1>' +
      '<p>Classic texts rendered chapter by chapter into modern English, each ' +
      'chapter with an overview, key concepts, and a glossary of archaic terms. ' +
      'Original texts are preserved alongside under each book’s ' +
      '<code>source/</code> directory.</p>' +
      library.books.map(function (b) {
        return '<a class="book-card" href="#/' + b.slug + '">' +
          '<h3>' + b.title + '</h3>' +
          '<div class="meta">' + b.author + ' · ' + b.year + '</div>' +
          '<p>' + (b.description || '') + '</p></a>';
      }).join('');
    window.scrollTo(0, 0);
  }

  function renderBookTOC(book, slug, activeFile) {
    bookLabel.textContent = book.author || '';
    var html = '<a href="#/' + slug + '"' +
      (activeFile ? '' : ' class="active"') + '>' +
      (book.title || slug) + ' — contents</a>';
    var lastGroup = null;
    (book.chapters || []).forEach(function (ch) {
      if (ch.group && ch.group !== lastGroup) {
        html += '<div class="toc-group">' + ch.group + '</div>';
        lastGroup = ch.group;
      }
      var file = ch.file.replace(/^chapters\//, '');
      var label = ch.label || ((ch.roman ? ch.roman + '. ' : '') + ch.title);
      html += '<a href="#/' + slug + '/' + file + '"' +
        (activeFile === file ? ' class="active"' : '') + '>' + label + '</a>';
    });
    setTOC(html);
  }

  function renderBookHome(slug, fragment) {
    return getBook(slug).then(function (book) {
      return fetchMD(book._path + '/README.md').then(function (md) {
        document.title = book.title;
        renderBookTOC(book, slug, null);
        content.innerHTML = marked.parse(stripFrontMatter(md));
        rewriteLinks(slug, book, true, null);
        decorateContent(slug, null);
        scrollToFragment(fragment);
      });
    });
  }

  function renderChapter(slug, file, fragment) {
    return getBook(slug).then(function (book) {
      return fetchMD(book._path + '/chapters/' + file).then(function (md) {
        var ch = (book.chapters || []).find(function (c) {
          return c.file.replace(/^chapters\//, '') === file;
        });
        document.title = (ch ? ch.title + ' — ' : '') + book.title;
        renderBookTOC(book, slug, file);
        content.innerHTML = marked.parse(stripFrontMatter(md));
        rewriteLinks(slug, book, false, file);
        decorateContent(slug, file);
        scrollToFragment(fragment);
      });
    });
  }

  function route() {
    var hash = location.hash.replace(/^#\/?/, '');
    var fragment = '';
    var fragmentStart = hash.indexOf('#');
    if (fragmentStart !== -1) {
      fragment = hash.slice(fragmentStart + 1);
      hash = hash.slice(0, fragmentStart);
    }
    var parts = hash.split('/').filter(Boolean);
    var p;
    if (!library) {
      p = fetchJSON('books/index.json').then(function (lib) { library = lib; });
    } else {
      p = Promise.resolve();
    }
    p.then(function () {
      if (parts.length === 0) return renderLibrary();
      if (parts.length === 1) return renderBookHome(parts[0], fragment);
      return renderChapter(parts[0], parts[1], fragment);
    }).catch(function (err) {
      content.innerHTML = '<h1>Not found</h1><p>' + err.message + '</p>' +
        '<p><a href="#/">Back to the library</a></p>';
    });
  }

  window.addEventListener('hashchange', route);
  route();
})();
