/* ============================================================
   MIFQuiz — 课程共用测验组件
   用法：
     MIFQuiz.mount(document.getElementById('quiz'), [
       { prompt: '问题',
         options: ['甲', '乙', '丙'],   // 选项字符数应相等
         answer: 0,                     // 正确项下标
         explain: '答对后的解释（可引用出处）' },
     ]);
   行为：点选即时反馈；答错可重选；全部答对显示小结。
   ============================================================ */
(function (global) {
  'use strict';

  function mount(root, questions) {
    if (!root || !Array.isArray(questions)) return;

    var answered = new Array(questions.length).fill(false);
    var tries = 0;

    var wrap = document.createElement('div');
    wrap.className = 'quiz';
    root.appendChild(wrap);

    questions.forEach(function (q, qi) {
      var box = document.createElement('div');
      box.className = 'q';

      var prompt = document.createElement('div');
      prompt.className = 'q-prompt';
      prompt.textContent = 'Q' + (qi + 1) + ' · ' + q.prompt;
      box.appendChild(prompt);

      var opts = document.createElement('div');
      opts.className = 'opts';

      var explain = document.createElement('div');
      explain.className = 'explain hidden';
      explain.textContent = q.explain || '';

      q.options.forEach(function (opt, oi) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = opt;
        btn.addEventListener('click', function () {
          if (answered[qi]) return;
          tries++;
          if (oi === q.answer) {
            answered[qi] = true;
            btn.classList.add('correct');
            Array.prototype.forEach.call(opts.children, function (b) { b.disabled = true; });
            explain.classList.remove('hidden');
            maybeFinish();
          } else {
            btn.classList.add('wrong');
            btn.disabled = true;
          }
        });
        opts.appendChild(btn);
      });

      box.appendChild(opts);
      box.appendChild(explain);
      wrap.appendChild(box);
    });

    var score = document.createElement('div');
    score.className = 'score';
    wrap.appendChild(score);

    function maybeFinish() {
      if (answered.every(Boolean)) {
        score.textContent = '全部答对 · 用了 ' + tries + ' 次点击（' + questions.length + ' 题）';
      }
    }
  }

  global.MIFQuiz = { mount: mount };
})(window);
