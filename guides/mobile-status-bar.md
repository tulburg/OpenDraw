# Mobile status bar

Paste-ready status bar for the top of a mobile artboard (390 px wide, iPhone style). Insert it as the artboard's first child with `write_html` (`mode: "insert-children"`), then put the screen content below it. For a dark background, change `color` on the root to `#ffffff`; the icons use `currentColor`.

```html
<div layer-name="Status Bar" style="display: flex; align-items: center; justify-content: space-between; width: 100%; height: 54px; padding: 18px 28px 0 36px; flex-shrink: 0; color: #000000; font-family: -apple-system, 'SF Pro Text', Inter, system-ui, sans-serif">
  <span layer-name="Time" style="font-size: 17px; line-height: 22px; font-weight: 600; letter-spacing: -0.02em">9:41</span>
  <div layer-name="Indicators" style="display: flex; align-items: center; gap: 7px">
    <svg layer-name="Signal" width="19" height="12" viewBox="0 0 19 12" fill="currentColor"><rect x="0" y="7.5" width="3" height="4.5" rx="1"/><rect x="5" y="5" width="3" height="7" rx="1"/><rect x="10" y="2.5" width="3" height="9.5" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>
    <svg layer-name="Wi-Fi" width="17" height="12" viewBox="0 0 17 12" fill="currentColor"><path d="M8.5 2.3c2.3 0 4.4.9 6 2.4l1.2-1.2A10.2 10.2 0 0 0 8.5.6 10.2 10.2 0 0 0 1.3 3.5l1.2 1.2c1.6-1.5 3.7-2.4 6-2.4Z"/><path d="M8.5 5.7c1.4 0 2.6.5 3.6 1.4l1.2-1.2a6.8 6.8 0 0 0-9.6 0l1.2 1.2c1-.9 2.2-1.4 3.6-1.4Z"/><path d="M8.5 9.1c.5 0 .9.2 1.2.5L8.5 10.8 7.3 9.6c.3-.3.7-.5 1.2-.5Z"/></svg>
    <svg layer-name="Battery" width="27" height="13" viewBox="0 0 27 13" fill="none"><rect x="0.5" y="0.5" width="23" height="12" rx="3.5" stroke="currentColor" opacity="0.35"/><rect x="2" y="2" width="20" height="9" rx="2" fill="currentColor"/><path d="M25 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2Z" fill="currentColor" opacity="0.4"/></svg>
  </div>
</div>
```

For Android, use a 24 px tall bar with `padding: 0 16px`, the time at 14 px, and the same indicators scaled to 16 px.
