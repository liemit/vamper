document.addEventListener('DOMContentLoaded', function () {
  var container = document.querySelector('[data-categories-slider]');
  if (!container) return;

  var track = container.querySelector('[data-categories-track]');
  var prevBtn = container.querySelector('[data-categories-prev]');
  var nextBtn = container.querySelector('[data-categories-next]');

  if (!track || !prevBtn || !nextBtn) return;

  function getScrollStep() {
    var firstCard = track.querySelector('.category-slide');
    if (!firstCard) return 320;

    var rect = firstCard.getBoundingClientRect();
    var styles = window.getComputedStyle(track);
    var gap = parseFloat(styles.columnGap || styles.gap || '0') || 0;
    return Math.max(220, Math.floor(rect.width + gap));
  }

  function updateButtons() {
    var maxScroll = track.scrollWidth - track.clientWidth;
    var x = track.scrollLeft;

    prevBtn.disabled = x <= 2;
    nextBtn.disabled = x >= maxScroll - 2;
  }

  function scrollByStep(dir) {
    track.scrollBy({ left: dir * getScrollStep(), behavior: 'smooth' });
  }

  prevBtn.addEventListener('click', function () {
    scrollByStep(-1);
  });

  nextBtn.addEventListener('click', function () {
    scrollByStep(1);
  });

  track.addEventListener('scroll', function () {
    window.requestAnimationFrame(updateButtons);
  });

  window.addEventListener('resize', function () {
    window.requestAnimationFrame(updateButtons);
  });

  updateButtons();
});
