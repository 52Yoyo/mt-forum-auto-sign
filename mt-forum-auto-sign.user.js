// ==UserScript==
// @name         MT论坛自动签到
// @namespace    https://github.com/52Yoyo/mt-forum-auto-sign
// @version      2.1.0
// @description  MT论坛(bbs.binmt.cc)每日自动签到：打开任意页面静默签到，签到页显示 Material Design 3 悬浮面板，支持长按拖动按钮、恢复默认位置、定时签到、自动深浅色主题。兼容 Tampermonkey / Violentmonkey / Via 浏览器
// @author       YoyoAwA、DeepSeek
// @match        https://bbs.binmt.cc/*
// @grant        none
// @run-at       document-end
// @noframes
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    // ================================================================
    // 配置
    // ================================================================
    var BASE = 'https://bbs.binmt.cc';
    var SIGN_PAGE = BASE + '/k_misign-sign.html';
    var LOGIN_URL = BASE + '/member.php?mod=logging&action=login';
    var DONE_PREFIX = 'mt_sign_done_';
    var SETTINGS_KEY = 'mtas_settings';
    var LOG_KEY = 'mtas_log';
    var FAB_POS_KEY = 'mtas_fab_pos';
    var AUTO_DELAY = 1200;
    var TOAST_SHOW = 2600;
    var MAX_LOG = 8;
    var PRESS_DELAY = 400; // 长按进入拖动模式阈值(ms)

    var IS_SIGN_PAGE = location.pathname.indexOf('k_misign-sign') >= 0;

    var DEFAULT_SETTINGS = {
        auto: true,
        timed: false,
        timedTime: '08:00',
        toast: true
    };

    // 必须在最早期声明（之前漏了导致 main 抛 ReferenceError，UI 完全不显示）
    var settings = DEFAULT_SETTINGS;
    var state = 'idle';
    var timedTimer = null;

    // ================================================================
    // 存储
    // ================================================================
    function todayStr() {
        var d = new Date();
        var m = String(d.getMonth() + 1).padStart(2, '0');
        var day = String(d.getDate()).padStart(2, '0');
        return d.getFullYear() + '-' + m + '-' + day;
    }

    function loadSettings() {
        try {
            var s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
            if (s) return Object.assign({}, DEFAULT_SETTINGS, s);
        } catch (e) {}
        return Object.assign({}, DEFAULT_SETTINGS);
    }

    function saveSettings(s) {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
    }

    function markDone() { try { localStorage.setItem(DONE_PREFIX + todayStr(), '1'); } catch (e) {} }

    function isDone() {
        try { return localStorage.getItem(DONE_PREFIX + todayStr()) === '1'; } catch (e) { return false; }
    }

    function addLog(status, msg) {
        try {
            var log = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
            log.unshift({
                time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
                date: todayStr(),
                status: status, // success / already / login / err / unknown
                msg: msg
            });
            if (log.length > MAX_LOG) log.length = MAX_LOG;
            localStorage.setItem(LOG_KEY, JSON.stringify(log));
        } catch (e) {}
    }

    function getLog() {
        try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch (e) { return []; }
    }

    // ---- FAB 位置存取 ----
    function getFabPos() {
        try { return JSON.parse(localStorage.getItem(FAB_POS_KEY) || 'null'); } catch (e) { return null; }
    }

    function saveFabPos(x, y) {
        try { localStorage.setItem(FAB_POS_KEY, JSON.stringify({ x: x, y: y })); } catch (e) {}
    }

    function clearFabPos() {
        try { localStorage.removeItem(FAB_POS_KEY); } catch (e) {}
    }

    // ================================================================
    // 签到核心
    // ================================================================
    function parseSignPage(html) {
        var formhash = null;
        var extra = '';
        var m;

        // 1) 优先提取签到按钮的完整链接(包含 operation=qiandao 的 a 标签)
        m = html.match(/href=["']([^"']*operation=qiandao[^"']*)["']/i);
        if (m) {
            var fh = m[1].match(/formhash=([a-f0-9]{8})/i);
            if (fh) formhash = fh[1];
            var fmt = m[1].match(/format=[a-z]+/i);
            if (fmt) extra = fmt[0];
        }
        // 2) 表单隐藏域
        if (!formhash) {
            m = html.match(/name=["']formhash["']\s+value=["']([a-f0-9]{8})["']/i) ||
                html.match(/formhash["']?\s*[:=]\s*["']?([a-f0-9]{8})/i);
            if (m) formhash = m[1];
        }
        return { formhash: formhash, extra: extra || 'format=text' };
    }

    function doSign() {
        return fetch(SIGN_PAGE, { credentials: 'include' })
            .then(function (res) {
                if (!res.ok) throw new Error('签到页请求失败 HTTP ' + res.status);
                return res.text();
            })
            .then(function (html) {
                var info = parseSignPage(html);
                if (!info.formhash) {
                    if (/login|登录/i.test(html)) {
                        return { status: 'login', msg: '未登录，请先登录 MT 论坛账号' };
                    }
                    throw new Error('未找到 formhash（页面结构可能变了）');
                }

                var url = BASE + '/plugin.php?id=k_misign:sign&operation=qiandao&formhash=' +
                          info.formhash + '&' + info.extra + '&inajax=1';

                return fetch(url, {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                        'X-Requested-With': 'XMLHttpRequest',
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Referer': SIGN_PAGE
                    }
                }).then(function (r) { return r.text(); })
                  .then(function (text) {
                      // 部分插件版本不响应 POST 时 GET 兜底
                      if (!text || !text.trim() || /formhash|operation=qiandao/i.test(text)) {
                          return fetch(url + '&format=text', {
                              method: 'GET',
                              credentials: 'include',
                              headers: { 'X-Requested-With': 'XMLHttpRequest', 'Referer': SIGN_PAGE }
                          }).then(function (r2) { return r2.text(); })
                            .then(function (t2) { return (t2 && t2.trim()) ? t2 : text; });
                      }
                      return text;
                  })
                  .then(parseResult);
            });
    }

    function parseResult(text) {
        if (/已经签到|今日已签|重复签到|已签到过|不要重复/i.test(text)) {
            return { status: 'already', msg: '今日已签到' };
        }
        if (/签到成功|签到完成|^成功|获得.{0,20}(金币|积分|经验|威望|贡献)/i.test(text)) {
            return { status: 'success', msg: '签到成功' };
        }
        if (/登录|login/i.test(text)) {
            return { status: 'login', msg: '未登录，签到失败' };
        }
        if (!text || !text.trim()) {
            return { status: 'success', msg: '签到请求已发出' };
        }
        return { status: 'unknown', msg: text.replace(/<[^>]+>/g, '').slice(0, 80) };
    }

    // ================================================================
    // Material Design 3 样式（浅色 / 深色自动跟随系统）
    // ================================================================
    var STYLE_ID = 'mtas-style';

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;

        var md = [
            // ---------- 设计令牌 ----------
            ':root{',
            '--mtas-primary:#0b57d0;--mtas-on-primary:#fff;',
            '--mtas-primary-container:#d8e2ff;--mtas-on-primary-container:#001a41;',
            '--mtas-secondary-container:#d9e2f9;--mtas-on-secondary-container:#0a1d3c;',
            '--mtas-surface:#f9f9ff;--mtas-surface-container:#f1f0f9;--mtas-surface-container-high:#e9e8f2;',
            '--mtas-on-surface:#191c20;--mtas-on-surface-variant:#44474f;',
            '--mtas-outline:#74777f;--mtas-outline-variant:#c4c6d0;',
            '--mtas-error:#ba1a1a;--mtas-error-container:#ffdad6;--mtas-on-error-container:#410002;',
            '--mtas-inverse-surface:#2e3137;--mtas-inverse-on-surface:#f1f0f9;',
            '--mtas-success:#166534;--mtas-success-container:#d3f0db;',
            '--mtas-shadow:0 1px 3px rgba(0,0,0,.12),0 4px 16px rgba(0,0,0,.12);',
            '--mtas-easing:cubic-bezier(.2,0,0,1);',
            '}',
            '@media (prefers-color-scheme:dark){:root{',
            '--mtas-primary:#aac7ff;--mtas-on-primary:#002f52;',
            '--mtas-primary-container:#00477d;--mtas-on-primary-container:#d1e4ff;',
            '--mtas-secondary-container:#2a3b58;--mtas-on-secondary-container:#d9e2f9;',
            '--mtas-surface:#141318;--mtas-surface-container:#1e1e24;--mtas-surface-container-high:#292830;',
            '--mtas-on-surface:#e4e1e9;--mtas-on-surface-variant:#c7c5d0;',
            '--mtas-outline:#90909a;--mtas-outline-variant:#44464f;',
            '--mtas-error:#ffb4ab;--mtas-error-container:#93000a;--mtas-on-error-container:#ffdad6;',
            '--mtas-inverse-surface:#e4e1e9;--mtas-inverse-on-surface:#2e3137;',
            '--mtas-success:#86efac;--mtas-success-container:#14532d;',
            '--mtas-shadow:0 1px 3px rgba(0,0,0,.5),0 4px 16px rgba(0,0,0,.5);',
            '}}',

            // ---------- FAB ----------
            '#mtas-fab{position:fixed;right:16px;bottom:18px;z-index:2147483000;width:56px;height:56px;',
            'border-radius:16px;background:var(--mtas-primary-container);color:var(--mtas-on-primary-container);',
            'display:flex;align-items:center;justify-content:center;border:none;outline:none;padding:0;',
            'font-family:"Segoe UI",system-ui,-apple-system,sans-serif;cursor:pointer;',
            'box-shadow:var(--mtas-shadow);transition:transform .15s var(--mtas-easing),box-shadow .2s var(--mtas-easing);',
            '-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none;touch-action:none}',
            '#mtas-fab:hover{box-shadow:0 2px 6px rgba(0,0,0,.2),0 6px 20px rgba(0,0,0,.2)}',
            '#mtas-fab:active{transform:scale(.92)}',
            '#mtas-fab.mtas-dragging{transform:scale(1.15);cursor:grabbing;',
            'box-shadow:0 6px 20px rgba(0,0,0,.35);opacity:.92}',
            '#mtas-fab svg{width:26px;height:26px;pointer-events:none}',
            '#mtas-fab.mtas-done{background:var(--mtas-success-container);color:#166534}',
            '@media (prefers-color-scheme:dark){#mtas-fab.mtas-done{color:#86efac}}',
            '#mtas-fab.mtas-err{background:var(--mtas-error-container);color:var(--mtas-on-error-container)}',

            // ---------- 面板 ----------
            '#mtas-panel{position:fixed;right:16px;bottom:86px;z-index:2147483000;width:340px;',
            'max-width:calc(100vw - 24px);background:var(--mtas-surface-container);color:var(--mtas-on-surface);',
            'border-radius:28px;box-shadow:var(--mtas-shadow);overflow:hidden;display:none;',
            'font-family:"Segoe UI",system-ui,-apple-system,sans-serif}',
            '#mtas-panel.mtas-open{display:block;animation:mtasPop .3s var(--mtas-easing)}',
            '@keyframes mtasPop{from{opacity:0;transform:translateY(12px) scale(.96)}to{opacity:1;transform:none}}',
            '#mtas-panel *{box-sizing:border-box}',
            '#mtas-panel button{font-family:inherit}',
            '#mtas-panel input{font-family:inherit}',

            // ---------- 头部 ----------
            '#mtas-head{display:flex;align-items:center;gap:12px;padding:16px 20px 12px}',
            '#mtas-head-icon{width:40px;height:40px;border-radius:12px;flex:none;',
            'background:var(--mtas-primary-container);color:var(--mtas-on-primary-container);',
            'display:flex;align-items:center;justify-content:center}',
            '#mtas-head-icon svg{width:22px;height:22px}',
            '#mtas-title{flex:1;font-size:16px;font-weight:600;line-height:1.3;color:var(--mtas-on-surface)}',
            '#mtas-subtitle{font-size:12px;color:var(--mtas-on-surface-variant);margin-top:2px}',
            '#mtas-close{width:36px;height:36px;border:none;background:transparent;color:var(--mtas-on-surface-variant);',
            'border-radius:18px;cursor:pointer;font-size:20px;line-height:1;display:flex;align-items:center;justify-content:center;',
            'transition:background .15s var(--mtas-easing)}',
            '#mtas-close:hover{background:var(--mtas-surface-container-high)}',

            // ---------- 状态卡片 ----------
            '#mtas-status-card{margin:0 16px;padding:14px 16px;border-radius:16px;',
            'background:var(--mtas-primary-container);color:var(--mtas-on-primary-container);',
            'transition:background .25s var(--mtas-easing),color .25s var(--mtas-easing)}',
            '#mtas-status-card.mtas-done{background:var(--mtas-success-container)}',
            '#mtas-status-card.mtas-err{background:var(--mtas-error-container);color:var(--mtas-on-error-container)}',
            '#mtas-status-title{font-size:13px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;opacity:.75;margin-bottom:6px}',
            '#mtas-status-text{font-size:14px;line-height:1.55;margin:0 0 12px;word-break:break-all;white-space:pre-wrap}',
            '#mtas-actions{display:flex;gap:8px}',
            '#mtas-btn-sign{flex:1;height:40px;border:none;border-radius:20px;',
            'background:var(--mtas-on-primary-container);color:var(--mtas-primary-container);',
            'font-size:14px;font-weight:600;cursor:pointer;',
            'transition:opacity .15s var(--mtas-easing),transform .1s var(--mtas-easing)}',
            '#mtas-btn-sign:active{transform:scale(.96)}',
            '#mtas-btn-sign:disabled{opacity:.5;cursor:default}',
            '#mtas-btn-login{flex:1;height:40px;border:1px solid currentColor;border-radius:20px;',
            'background:transparent;color:inherit;font-size:14px;font-weight:600;cursor:pointer;',
            'transition:opacity .15s var(--mtas-easing)}',
            '#mtas-btn-login:hover{opacity:.8}',

            // ---------- 设置 ----------
            '#mtas-settings{padding:8px 16px 4px}',
            '#mtas-section-label{font-size:12px;font-weight:600;letter-spacing:.8px;text-transform:uppercase;',
            'color:var(--mtas-on-surface-variant);padding:14px 4px 4px}',
            '.mtas-row{display:flex;align-items:center;gap:12px;padding:10px 4px;min-height:48px}',
            '.mtas-row + .mtas-row{border-top:1px solid var(--mtas-outline-variant)}',
            '.mtas-row-text{flex:1;min-width:0}',
            '.mtas-row-title{font-size:14px;color:var(--mtas-on-surface);font-weight:500}',
            '.mtas-row-sub{font-size:12px;color:var(--mtas-on-surface-variant);margin-top:2px}',
            '.mtas-row-ctrl{flex:none;display:flex;align-items:center;gap:8px}',
            '#mtas-time-input{border:1px solid var(--mtas-outline-variant);border-radius:8px;background:transparent;',
            'color:var(--mtas-on-surface);font-size:13px;padding:6px 8px;outline:none;',
            'transition:border-color .15s var(--mtas-easing)}',
            '#mtas-time-input:focus{border-color:var(--mtas-primary)}',
            '#mtas-time-input:disabled{opacity:.4}',

            // ---------- MD3 Switch ----------
            '.mtas-switch{position:relative;display:inline-block;width:52px;height:32px;flex:none;cursor:pointer}',
            '.mtas-switch input{position:absolute;opacity:0;width:0;height:0}',
            '.mtas-track{position:absolute;inset:0;border-radius:16px;border:2px solid var(--mtas-outline);',
            'background:transparent;transition:background .2s var(--mtas-easing),border-color .2s var(--mtas-easing)}',
            '.mtas-thumb{position:absolute;top:50%;left:2px;width:16px;height:16px;border-radius:50%;',
            'transform:translate(2px,-50%);background:var(--mtas-outline);',
            'transition:transform .2s var(--mtas-easing),background .2s var(--mtas-easing)}',
            '.mtas-switch input:checked + .mtas-track{background:var(--mtas-primary);border-color:var(--mtas-primary)}',
            '.mtas-switch input:checked + .mtas-track .mtas-thumb{transform:translate(30px,-50%);background:var(--mtas-on-primary)}',
            '.mtas-switch input:disabled + .mtas-track{opacity:.5}',

            // ---------- 签到记录 ----------
            '#mtas-log{padding:0 16px 12px}',
            '#mtas-log-list{margin:0;padding:0;list-style:none}',
            '#mtas-log-list li{display:flex;align-items:center;gap:10px;padding:7px 4px;font-size:13px;color:var(--mtas-on-surface-variant)}',
            '#mtas-log-list li + li{border-top:1px solid var(--mtas-outline-variant)}',
            '.mtas-log-dot{width:8px;height:8px;border-radius:50%;flex:none}',
            '.mtas-log-dot.s{background:#22a06b}.mtas-log-dot.a{background:var(--mtas-primary)}',
            '.mtas-log-dot.l,.mtas-log-dot.e,.mtas-log-dot.u{background:var(--mtas-error)}',
            '.mtas-log-time{flex:none;font-size:12px;color:var(--mtas-on-surface-variant);width:64px}',
            '.mtas-log-msg{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '#mtas-clear{width:100%;height:36px;border:none;border-radius:18px;margin-top:6px;',
            'background:transparent;color:var(--mtas-error);font-size:13px;font-weight:600;cursor:pointer;',
            'transition:background .15s var(--mtas-easing)}',
            '#mtas-clear:hover{background:var(--mtas-error-container)}',
            '#mtas-empty-log{padding:8px 4px;font-size:13px;color:var(--mtas-on-surface-variant)}',

            // ---------- Snackbar ----------
            '#mtas-toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%) translateY(20px);',
            'z-index:2147483001;background:var(--mtas-inverse-surface);color:var(--mtas-inverse-on-surface);',
            'font-size:14px;padding:12px 20px;border-radius:6px;box-shadow:var(--mtas-shadow);',
            'font-family:"Segoe UI",system-ui,-apple-system,sans-serif;opacity:0;pointer-events:none;',
            'max-width:min(480px,calc(100vw - 32px));text-align:center;',
            'transition:opacity .25s var(--mtas-easing),transform .25s var(--mtas-easing)}',
            '#mtas-toast.mtas-show{opacity:1;transform:translateX(-50%) translateY(0)}',

            // ---------- 手机端 ----------
            '@media (max-width:480px){',
            '#mtas-fab{right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px))}',
            '#mtas-panel{right:12px;bottom:78px;width:min(340px,calc(100vw - 24px))}',
            '#mtas-toast{bottom:calc(88px + env(safe-area-inset-bottom,0px))}',
            '}'
        ].join('\n');

        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = md;
        (document.head || document.documentElement).appendChild(style);
    }

    // ================================================================
    // UI 构建（仅签到页显示）
    // ================================================================

    var ICON_SIGN =
        '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<rect x="3" y="5" width="18" height="16" rx="3" stroke="currentColor" stroke-width="2"/>' +
        '<path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
        '<path d="m8.5 15.5 2.5 2.5 4.5-4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
        '</svg>';

    function showToast(text) {
        var toast = document.getElementById('mtas-toast');
        if (!toast) return;
        toast.textContent = text;
        toast.classList.add('mtas-show');
        clearTimeout(showToast._t);
        showToast._t = setTimeout(function () {
            toast.classList.remove('mtas-show');
        }, TOAST_SHOW);
    }

    function buildUI() {
        if (document.getElementById('mtas-fab')) return;
        injectStyle();

        // FAB
        var fab = document.createElement('button');
        fab.id = 'mtas-fab';
        fab.title = 'MT论坛签到（长按可拖动）';
        fab.innerHTML = ICON_SIGN;
        fab.addEventListener('click', function () {
            if (fab.__dragging) { fab.__dragging = false; return; } // 拖动结束后的 click 忽略
            togglePanel();
        });
        applyFabPos(fab);
        enableFabDrag(fab);

        // 面板
        var panel = document.createElement('div');
        panel.id = 'mtas-panel';

        // 头部
        var head = document.createElement('div');
        head.id = 'mtas-head';
        var headIcon = document.createElement('div');
        headIcon.id = 'mtas-head-icon';
        headIcon.innerHTML = ICON_SIGN;
        var titleBox = document.createElement('div');
        titleBox.style.cssText = 'flex:1;min-width:0';
        var title = document.createElement('div');
        title.id = 'mtas-title';
        title.textContent = 'MT论坛自动签到';
        var subtitle = document.createElement('div');
        subtitle.id = 'mtas-subtitle';
        subtitle.textContent = '签到页专属 · 自动适配主题';
        titleBox.appendChild(title);
        titleBox.appendChild(subtitle);
        var close = document.createElement('button');
        close.id = 'mtas-close';
        close.textContent = '\u00d7';
        close.title = '关闭';
        close.addEventListener('click', function () { togglePanel(false); });
        head.appendChild(headIcon);
        head.appendChild(titleBox);
        head.appendChild(close);

        // 状态卡片
        var statusCard = document.createElement('div');
        statusCard.id = 'mtas-status-card';
        var statusTitle = document.createElement('div');
        statusTitle.id = 'mtas-status-title';
        statusTitle.textContent = '签到状态';
        var statusText = document.createElement('div');
        statusText.id = 'mtas-status-text';
        var actions = document.createElement('div');
        actions.id = 'mtas-actions';
        var btnSign = document.createElement('button');
        btnSign.id = 'mtas-btn-sign';
        var btnLogin = document.createElement('button');
        btnLogin.id = 'mtas-btn-login';
        btnLogin.textContent = '去登录';
        btnLogin.style.display = 'none';
        actions.appendChild(btnSign);
        actions.appendChild(btnLogin);
        statusCard.appendChild(statusTitle);
        statusCard.appendChild(statusText);
        statusCard.appendChild(actions);

        // 设置区
        var settingsBox = document.createElement('div');
        settingsBox.id = 'mtas-settings';
        var label = document.createElement('div');
        label.className = 'mtas-section-label';
        label.id = 'mtas-section-label';
        label.textContent = '设置';
        label.style.cssText = 'font-size:12px;font-weight:600;letter-spacing:.8px;text-transform:uppercase;color:var(--mtas-on-surface-variant);padding:14px 4px 4px';
        settingsBox.appendChild(label);

        settingsBox.appendChild(makeSwitchRow(
            '自动签到', '打开论坛任意页面自动签到', 'auto',
            function (checked) { onAutoToggle(checked); }
        ));

        var timedRow = makeSwitchRow(
            '定时签到', '每天指定时间自动签到', 'timed',
            function (checked) { onTimedToggle(checked); }
        );
        settingsBox.appendChild(timedRow);

        // 时间选择行（附属于定时签到）
        var timeRow = document.createElement('div');
        timeRow.className = 'mtas-row';
        timeRow.id = 'mtas-time-row';
        timeRow.style.display = 'none';
        var timeText = document.createElement('div');
        timeText.className = 'mtas-row-text';
        var timeTitle = document.createElement('div');
        timeTitle.className = 'mtas-row-title';
        timeTitle.textContent = '签到时间';
        var timeSub = document.createElement('div');
        timeSub.className = 'mtas-row-sub';
        timeSub.textContent = '页面保持打开时生效';
        timeText.appendChild(timeTitle);
        timeText.appendChild(timeSub);
        var timeInput = document.createElement('input');
        timeInput.type = 'time';
        timeInput.id = 'mtas-time-input';
        timeInput.value = settings.timedTime;
        timeInput.addEventListener('change', function () {
            settings.timedTime = timeInput.value || '08:00';
            saveSettings(settings);
            scheduleTimedSign();
        });
        timeRow.appendChild(timeText);
        timeRow.appendChild(timeInput);
        settingsBox.appendChild(timeRow);

        settingsBox.appendChild(makeSwitchRow(
            '结果提示', '签到完成后弹出提示', 'toast', function () {}
        ));

        // 恢复 FAB 默认位置
        var resetPosRow = document.createElement('div');
        resetPosRow.className = 'mtas-row';
        resetPosRow.style.cssText = 'justify-content:center;padding:6px 4px 10px';
        var resetPosBtn = document.createElement('button');
        resetPosBtn.id = 'mtas-reset-pos';
        resetPosBtn.textContent = '恢复按钮默认位置';
        resetPosBtn.style.cssText = 'height:36px;padding:0 18px;border:none;border-radius:18px;' +
            'background:var(--mtas-surface-container-high);color:var(--mtas-on-surface);' +
            'font-size:13px;font-weight:500;cursor:pointer;' +
            'transition:opacity .15s var(--mtas-easing)';
        resetPosBtn.addEventListener('click', resetFabPos);
        resetPosRow.appendChild(resetPosBtn);
        settingsBox.appendChild(resetPosRow);

        // 签到记录
        var logBox = document.createElement('div');
        logBox.id = 'mtas-log';
        var logLabel = document.createElement('div');
        logLabel.textContent = '签到记录';
        logLabel.style.cssText = 'font-size:12px;font-weight:600;letter-spacing:.8px;text-transform:uppercase;color:var(--mtas-on-surface-variant);padding:14px 4px 6px';
        var logList = document.createElement('ul');
        logList.id = 'mtas-log-list';
        var clearBtn = document.createElement('button');
        clearBtn.id = 'mtas-clear';
        clearBtn.textContent = '清空记录';
        clearBtn.addEventListener('click', function () {
            try { localStorage.removeItem(LOG_KEY); } catch (e) {}
            renderLog();
        });
        logBox.appendChild(logLabel);
        logBox.appendChild(logList);
        logBox.appendChild(clearBtn);

        panel.appendChild(head);
        panel.appendChild(statusCard);
        panel.appendChild(settingsBox);
        panel.appendChild(logBox);

        var toast = document.createElement('div');
        toast.id = 'mtas-toast';

        document.body.appendChild(fab);
        document.body.appendChild(panel);
        document.body.appendChild(toast);

        btnSign.addEventListener('click', manualSign);
        btnLogin.addEventListener('click', function () {
            window.open(LOGIN_URL, '_blank');
        });

        syncSettingsUI();
        renderLog();
        setState('idle');
    }

    function makeSwitchRow(title, sub, key, onToggle) {
        var row = document.createElement('div');
        row.className = 'mtas-row';

        var text = document.createElement('div');
        text.className = 'mtas-row-text';
        var t1 = document.createElement('div');
        t1.className = 'mtas-row-title';
        t1.textContent = title;
        var t2 = document.createElement('div');
        t2.className = 'mtas-row-sub';
        t2.textContent = sub;
        text.appendChild(t1);
        text.appendChild(t2);

        var ctrl = document.createElement('div');
        ctrl.className = 'mtas-row-ctrl';

        var label = document.createElement('label');
        label.className = 'mtas-switch';
        var input = document.createElement('input');
        input.type = 'checkbox';
        input.dataset.settingKey = key;
        var track = document.createElement('span');
        track.className = 'mtas-track';
        var thumb = document.createElement('span');
        thumb.className = 'mtas-thumb';
        track.appendChild(thumb);
        label.appendChild(input);
        label.appendChild(track);
        ctrl.appendChild(label);
        row.appendChild(text);
        row.appendChild(ctrl);

        input.addEventListener('change', function () {
            settings[key] = input.checked;
            saveSettings(settings);
            if (onToggle) onToggle(input.checked);
        });
        return row;
    }

    function syncSettingsUI() {
        var inputs = document.querySelectorAll('#mtas-panel input[type="checkbox"]');
        inputs.forEach(function (i) {
            var k = i.dataset.settingKey;
            if (k in settings) i.checked = !!settings[k];
        });
        var timeRow = document.getElementById('mtas-time-row');
        var timeInput = document.getElementById('mtas-time-input');
        if (timeRow) timeRow.style.display = settings.timed ? 'flex' : 'none';
        if (timeInput) timeInput.value = settings.timedTime;
    }

    function onAutoToggle(checked) {
        // 开启自动签到且今天未签 → 立即签一次
        if (checked && !isDone()) {
            setTimeout(function () { manualSign(true); }, 400);
        }
    }

    function onTimedToggle(checked) {
        var timeRow = document.getElementById('mtas-time-row');
        if (timeRow) timeRow.style.display = checked ? 'flex' : 'none';
        scheduleTimedSign();
    }

    function setState(s, statusText) {
        state = s;
        var fab = document.getElementById('mtas-fab');
        var card = document.getElementById('mtas-status-card');
        var statusTextEl = document.getElementById('mtas-status-text');
        var btnSign = document.getElementById('mtas-btn-sign');
        var btnLogin = document.getElementById('mtas-btn-login');
        if (!card || !statusTextEl || !btnSign) return;

        fab.className = '';
        card.className = '';
        if (s === 'done' || s === 'already') { fab.classList.add('mtas-done'); card.classList.add('mtas-done'); }
        if (s === 'err' || s === 'login') { fab.classList.add('mtas-err'); card.classList.add('mtas-err'); }

        var map = {
            idle:     { label: '立即签到', text: '今日尚未签到，点按钮立即签到', login: false, dis: false },
            working:  { label: '签到中…',  text: '正在签到，请稍候…',          login: false, dis: true  },
            done:     { label: '再签一次', text: statusText || '签到成功，明天再来', login: false, dis: false },
            already:  { label: '已签到',   text: statusText || '今天已经签到过啦', login: false, dis: true  },
            login:    { label: '去登录',   text: statusText || '请先登录论坛账号', login: true,  dis: false },
            err:      { label: '重试',     text: statusText || '签到出错，请重试', login: false, dis: false }
        };
        var m = map[s] || map.idle;
        btnSign.textContent = m.label;
        btnSign.disabled = m.dis;
        btnLogin.style.display = m.login ? '' : 'none';
        statusTextEl.textContent = m.text;
    }

    // 应用已保存的 FAB 位置（无则用 CSS 默认 right/bottom）
    function applyFabPos(fab) {
        var p = getFabPos();
        if (!p || typeof p.x !== 'number') return;
        var vw = window.innerWidth, vh = window.innerHeight;
        var x = Math.max(4, Math.min(p.x, vw - 60));
        var y = Math.max(4, Math.min(p.y, vh - 60));
        fab.style.left = x + 'px';
        fab.style.top = y + 'px';
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
    }

    // 窗口尺寸变化（旋转/缩放）时把 FAB 拉回可视区域
    function clampFabPos() {
        var fab = document.getElementById('mtas-fab');
        if (!fab || !getFabPos()) return;
        var vw = window.innerWidth, vh = window.innerHeight;
        var x = Math.max(4, Math.min(fab.offsetLeft, vw - fab.offsetWidth - 4));
        var y = Math.max(4, Math.min(fab.offsetTop, vh - fab.offsetHeight - 4));
        fab.style.left = x + 'px';
        fab.style.top = y + 'px';
        saveFabPos(x, y);
    }

    // 长按拖动 FAB
    function enableFabDrag(fab) {
        var pressTimer = null;
        var dragging = false;
        var startX = 0, startY = 0;
        var baseX = 0, baseY = 0;

        function getPos(e) {
            return (e.touches && e.touches[0]) ? e.touches[0] : e;
        }

        function onDown(e) {
            var p = getPos(e);
            startX = p.clientX;
            startY = p.clientY;
            baseX = fab.offsetLeft;
            baseY = fab.offsetTop;
            clearTimeout(pressTimer);
            pressTimer = setTimeout(function () {
                dragging = true;
                fab.classList.add('mtas-dragging');
                fab.__dragging = true;
                togglePanel(false); // 拖动时收起面板
                if (navigator.vibrate) { try { navigator.vibrate(30); } catch (err) {} }
            }, PRESS_DELAY);
        }

        function onMove(e) {
            if (!dragging) return;
            e.preventDefault();
            var p = getPos(e);
            var dx = p.clientX - startX;
            var dy = p.clientY - startY;
            var vw = window.innerWidth, vh = window.innerHeight;
            var x = Math.max(0, Math.min(baseX + dx, vw - fab.offsetWidth));
            var y = Math.max(0, Math.min(baseY + dy, vh - fab.offsetHeight));
            fab.style.left = x + 'px';
            fab.style.top = y + 'px';
            fab.style.right = 'auto';
            fab.style.bottom = 'auto';
        }

        function onUp(e) {
            clearTimeout(pressTimer);
            if (dragging) {
                dragging = false;
                fab.classList.remove('mtas-dragging');
                setTimeout(function () { fab.__dragging = false; }, 50);
                saveFabPos(fab.offsetLeft, fab.offsetTop);
            }
        }

        fab.addEventListener('mousedown', onDown);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        fab.addEventListener('touchstart', onDown, { passive: true });
        window.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('touchend', onUp);
        window.addEventListener('touchcancel', onUp);
        fab.addEventListener('dragstart', function (e) { e.preventDefault(); });
    }

    // 恢复 FAB 默认位置
    function resetFabPos() {
        clearFabPos();
        var fab = document.getElementById('mtas-fab');
        if (fab) {
            fab.style.left = '';
            fab.style.top = '';
            fab.style.right = '';
            fab.style.bottom = '';
        }
        var panel = document.getElementById('mtas-panel');
        if (panel) {
            panel.style.left = '';
            panel.style.top = '';
        }
        if (settings.toast) showToast('已恢复按钮默认位置');
    }

    // 面板跟随 FAB 位置显示（FAB 上方，空间不足则下方）
    function positionPanel() {
        var panel = document.getElementById('mtas-panel');
        var fab = document.getElementById('mtas-fab');
        if (!panel || !fab) return;
        var fr = fab.getBoundingClientRect();
        var vw = window.innerWidth, vh = window.innerHeight;
        var pw = panel.offsetWidth || 340;
        var ph = panel.offsetHeight || 380;

        // 水平：与 FAB 对齐（右边缘对齐，视口不足时收进屏幕）
        var x = fr.left + fr.width - pw;
        x = Math.max(8, Math.min(x, vw - pw - 8));
        // 垂直：优先放 FAB 上方
        var gap = 12;
        var above = fr.top - gap - ph;
        var y;
        if (above >= 8) {
            y = above;
        } else {
            y = Math.min(fr.bottom + gap, vh - ph - 8);
            if (y < 8) y = 8;
        }
        panel.style.left = x + 'px';
        panel.style.top = y + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
    }

    function togglePanel(show) {
        var panel = document.getElementById('mtas-panel');
        if (!panel) return;
        var open = typeof show === 'boolean' ? show : !panel.classList.contains('mtas-open');
        // 先显示面板（display:block），再测量并定位，动画从 opacity:0 开始所以视觉无跳变
        panel.classList.toggle('mtas-open', open);
        if (open) positionPanel();
    }

    function renderLog() {
        var list = document.getElementById('mtas-log-list');
        if (!list) return;
        var log = getLog();
        list.innerHTML = '';
        if (!log.length) {
            var li = document.createElement('li');
            li.id = 'mtas-empty-log';
            li.textContent = '暂无签到记录';
            list.appendChild(li);
            return;
        }
        var statusMap = { success: 's', already: 'a', login: 'l', err: 'e', unknown: 'u' };
        log.forEach(function (item) {
            var li = document.createElement('li');
            var dot = document.createElement('span');
            dot.className = 'mtas-log-dot ' + (statusMap[item.status] || 'u');
            var time = document.createElement('span');
            time.className = 'mtas-log-time';
            time.textContent = (item.date === todayStr() ? '今天 ' : (item.date.slice(5) + ' ')) + item.time;
            var msg = document.createElement('span');
            msg.className = 'mtas-log-msg';
            msg.textContent = item.msg;
            li.appendChild(dot);
            li.appendChild(time);
            li.appendChild(msg);
            list.appendChild(li);
        });
    }

    // ================================================================
    // 签到流程
    // ================================================================
    function manualSign(silent) {
        setState('working');
        doSign().then(function (r) {
            markDone();
            var s = r.status === 'success' ? 'done' : (r.status === 'already' ? 'already' : r.status);
            setState(s, r.msg);
            addLog(r.status, r.msg);
            renderLog();
            if (settings.toast && !silent) {
                if (r.status === 'success') showToast('MT论坛签到成功 ✔');
                else if (r.status === 'already') showToast('今日已签到 ✔');
                else showToast(r.msg);
            }
        }).catch(function (e) {
            setState('err', String(e && e.message || e));
            addLog('err', String(e && e.message || e));
            renderLog();
            if (settings.toast && !silent) showToast('签到失败：' + String(e && e.message || e));
        });
    }

    // ================================================================
    // 定时签到
    // ================================================================

    function scheduleTimedSign() {
        clearTimeout(timedTimer);
        if (!settings.timed) return;
        var now = new Date();
        var parts = (settings.timedTime || '08:00').split(':');
        var h = parseInt(parts[0], 10) || 8;
        var m = parseInt(parts[1], 10) || 0;
        var target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
        if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
        var wait = target.getTime() - now.getTime();
        if (wait > 2147483647) wait = 2147483647;
        timedTimer = setTimeout(function () {
            if (!isDone()) manualSign(true);
            scheduleTimedSign();
        }, wait);
    }

    // ================================================================
    // 主流程
    // ================================================================
    function safe(fn) {
        try { return fn(); } catch (e) { console.error('[MT签到]', e); }
    }

    function main() {
        safe(function () {
            // 1) 读设置
            var s = loadSettings();
            if (s) settings = s;

            // 2) 签到页构建 UI（含保底 FAB）
            if (IS_SIGN_PAGE) {
                safe(buildUI);
            }

            // 3) 自动签到
            setTimeout(function () {
                safe(function () {
                    if (settings.auto && !isDone()) {
                        manualSign(true);
                    } else if (isDone() && IS_SIGN_PAGE) {
                        setState('already', '今日已签到');
                    }
                });
            }, AUTO_DELAY);

            // 4) 定时签到调度
            safe(scheduleTimedSign);

            // 5) 窗口尺寸变化时校正 FAB 位置（手机旋转等）
            safe(function () {
                window.addEventListener('resize', clampFabPos);
            });

            console.log('[MT签到] 已就绪, 自动=' + settings.auto + ', 定时=' + settings.timed + ', 定时时间=' + settings.timedTime);
        });
    }

    try {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', main);
        } else {
            main();
        }
    } catch (e) {
        console.error('[MT签到] 启动失败:', e);
    }
})();
