/* ============================================================
   MIFSorter — 课程共用「按顺序点击」练习组件
   用法：
     MIFSorter.mount(document.getElementById('sorter'), {
       items: ['第一步', '第二步', '第三步'],  // 按正确顺序给出
       title: '按执行顺序依次点击'             // 可省略
     });
   行为：条目乱序放入池；点对一个位置立即锁定（绿）；
        点错该按钮闪红并可继续试；全部锁定显示完成。
   ============================================================ */
(function (global) {
  'use strict';

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function mount(root, cfg) {
    if (!root || !Array.isArray(cfg.items)) return;

    var items = cfg.items;
    var pool = shuffle(items.map(function (t, i) { return { text: t, idx: i }; }));
    var next = 0;

    var slotsWrap = document.createElement('div');
    slotsWrap.className = 'slots';
    var slotEls = items.map(function (_, i) {
      var slot = document.createElement('div');
      slot.className = 'slot';
      var no = document.createElement('span');
      no.className = 'slot-no';
      no.textContent = (i + 1) + '.';
      slot.appendChild(no);
      slotsWrap.appendChild(slot);
      return slot;
    });

    var poolWrap = document.createElement('div');
    poolWrap.className = 'pool';

    var doneMsg = document.createElement('div');
    doneMsg.className = 'done';

    pool.forEach(function (item) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = item.text;
      btn.addEventListener('click', function () {
        if (item.placed) return;
        if (item.idx === next) {
          item.placed = true;
          slotEls[next].classList.add('filled');
          var tag = document.createElement('span');
          tag.textContent = item.text;
          slotEls[next].appendChild(tag);
          btn.style.visibility = 'hidden';
          next++;
          if (next === items.length) {
            doneMsg.textContent = '✓ 顺序完整正确';
            root.appendChild(doneMsg);
          }
        } else {
          btn.classList.add('wrong');
          setTimeout(function () { btn.classList.remove('wrong'); }, 400);
        }
      });
      poolWrap.appendChild(btn);
    });

    if (cfg.title) {
      var head = document.createElement('div');
      head.className = 'card-head';
      head.textContent = cfg.title;
      root.appendChild(head);
    }
    root.appendChild(slotsWrap);
    root.appendChild(poolWrap);
  }

  global.MIFSorter = { mount: mount };
})(window);
