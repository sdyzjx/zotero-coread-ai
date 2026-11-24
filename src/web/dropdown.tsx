/**
 * Self-drawn dropdown. The settings page is a chrome HTML window opened with
 * openDialog, where Firefox has no content-select popup host: native <select>
 * popups render as stray option text on top of the form. This component keeps
 * everything inside the page's own DOM.
 */
import { useEffect, useRef, useState } from "preact/hooks";

export interface DropdownOption {
  value: string;
  label: string;
  /** Group heading shown above the first option of each group. */
  group?: string;
  /** Muted text shown to the right of the label. */
  note?: string;
  disabled?: boolean;
}

export function Dropdown({
  value,
  options,
  onChange,
  placeholder = "请选择",
  title,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (v: string) => void;
  placeholder?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [upward, setUpward] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open]);

  useEffect(() => {
    if (!open || !list.current) return;
    const el = list.current.querySelector<HTMLElement>(`[data-i="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const toggle = () => {
    if (!open && root.current) {
      const r = root.current.getBoundingClientRect();
      const below = window.innerHeight - r.bottom;
      setUpward(below < 240 && r.top > below);
      setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    }
    setOpen(!open);
  };

  const pick = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    onChange(o.value);
    setOpen(false);
  };

  const move = (d: number) => {
    if (!options.length) return;
    let i = active;
    for (let n = 0; n < options.length; n++) {
      i = (i + d + options.length) % options.length;
      if (!options[i].disabled) break;
    }
    setActive(i);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return toggle();
      move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (open) pick(active);
      else toggle();
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
    }
  };

  let lastGroup: string | undefined;
  return (
    <div class={`dd${open ? " open" : ""}`} ref={root}>
      <button type="button" class="dd-btn" title={title} onClick={toggle} onKeyDown={onKey}>
        <span class={current ? "dd-value" : "dd-value dd-ph"}>{current ? current.label : value || placeholder}</span>
        {current?.note && <span class="dd-note">{current.note}</span>}
        <span class="dd-chev" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div class={`dd-list${upward ? " up" : ""}`} ref={list} role="listbox">
          {options.map((o, i) => {
            const head = o.group && o.group !== lastGroup ? o.group : null;
            lastGroup = o.group;
            return (
              <>
                {head && <div class="dd-group">{head}</div>}
                <div
                  data-i={i}
                  role="option"
                  aria-selected={o.value === value}
                  class={`dd-opt${i === active ? " active" : ""}${o.value === value ? " selected" : ""}${o.disabled ? " disabled" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(i);
                  }}
                >
                  <span class="dd-label">{o.label}</span>
                  {o.note && <span class="dd-note">{o.note}</span>}
                </div>
              </>
            );
          })}
          {!options.length && <div class="dd-opt disabled">（无可选项）</div>}
        </div>
      )}
    </div>
  );
}
