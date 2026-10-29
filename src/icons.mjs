const paths = {
  plus: "M12 5v14M5 12h14",
  chat: "M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7A8.4 8.4 0 0 1 4 11.5a8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z",
  image:
    "M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM3 16l5-5 5 5 4-4 4 4M8 7h.01",
  file: "M14 2H5v20h14V7l-5-5ZM14 2v6h5M8 12h8M8 16h8",
  code: "m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16",
  idea: "M9 18h6M10 22h4M8 14a6 6 0 1 1 8 0c-1 .8-1 2-1 4H9c0-2 0-3.2-1-4Z",
  book: "M12 5v16M3 3c4 0 6 0 9 2 3-2 5-2 9-2v16c-4 0-6 0-9 2-3-2-5-2-9-2V3Z",
  send: "M12 19V5m-6 6 6-6 6 6",
  stop: "M6 6h12v12H6z",
  menu: "M4 6h16M4 12h16M4 18h16",
  theme: "M12 3a9 9 0 1 0 9 9c-5 2-11-4-9-9Z",
  download: "M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5",
  refresh: "M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 14 6M4 12a8 8 0 0 0 14 6",
  user: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM2 21v-3a7 7 0 0 1 14 0v3M19 9l3 3-3 3m-2-3h5",
};
export function icon(name) {
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.chat}"/></svg>`;
}
