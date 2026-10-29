"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronDown, Users, X } from "lucide-react";
import { Popover } from "radix-ui";
import type { ExperienceSelectOption } from "./ExperienceSelect";
import "./experience-multi-select.css";

export interface ExperienceMultiSelectProps {
  id?: string;
  name?: string;
  values: string[];
  onValuesChange: (values: string[]) => void;
  options: ExperienceSelectOption[];
  placeholder?: string;
  menuLabel?: string;
  maxValues?: number;
  itemLabel?: string;
  unit?: string;
  emptyMessage?: string;
  selectionHint?: string;
  icon?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  "aria-label"?: string;
  "aria-describedby"?: string;
}

/** A persistent checkbox picker: choosing an item leaves the other choices in view. */
export function ExperienceMultiSelect({ id, name, values, onValuesChange, options, placeholder = "选择授课教练", menuLabel = "选择授课教练", maxValues, itemLabel = "教练", unit = "位", emptyMessage = "暂无该科目的教练，请先完善教练档案。", selectionHint, icon = <Users size={15}/>, required = false, disabled = false, "aria-label": ariaLabel, "aria-describedby": ariaDescribedBy }: ExperienceMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);
  const popupId = useId();
  const popup = useRef<HTMLDivElement>(null);
  const selected = options.filter(option => values.includes(option.value));
  const available = options.filter(option => !option.disabled);
  const limit = maxValues !== undefined && Number.isFinite(maxValues) ? Math.max(1, Math.floor(maxValues)) : Infinity;
  const atLimit = values.length >= limit;
  const selectedAvailable = available.filter(option => values.includes(option.value));
  const selectionFilled = available.length > 0 && selectedAvailable.length >= Math.min(available.length, limit);
  const selectAvailable = () => {
    if (disabled) return;
    const next = [...selectedAvailable, ...available.filter(option => !values.includes(option.value))].slice(0, limit);
    onValuesChange(selectionFilled ? [] : next.map(option => option.value));
  };
  const toggle = (value: string) => {
    if (disabled) return;
    if (values.includes(value)) onValuesChange(values.filter(item => item !== value));
    else if (!atLimit && !options.find(option => option.value === value)?.disabled) onValuesChange([...values, value]);
  };
  function moveFocus(event: KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(popup.current?.querySelectorAll<HTMLButtonElement>('[role="checkbox"]:not(:disabled)') || []);
    if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(event.currentTarget);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  }
  const heading = selected.length > 2 ? `已选择 ${selected.length} ${unit}${itemLabel}` : selected.map(option => option.label).join("、");
  return <Popover.Root open={open} onOpenChange={next => { if (next) setPortalContainer(trigger.current?.closest<HTMLElement>("dialog[open]") || null); setOpen(next); }} modal>
    <span className="exp-multi-field">
      <Popover.Trigger asChild><button ref={trigger} id={id} type="button" className="exp-multi-trigger" disabled={disabled} role="combobox" aria-label={ariaLabel} aria-describedby={ariaDescribedBy} aria-haspopup="dialog" aria-controls={popupId} aria-expanded={open} aria-required={required || undefined} data-placeholder={!selected.length || undefined}>
        {icon}<span>{heading || placeholder}</span>{selected.length > 0 && <small>{selected.length} {unit}</small>}<ChevronDown size={15} className="exp-multi-chevron"/>
      </button></Popover.Trigger>
      {name && values.map(value => <input key={value} type="hidden" name={name} value={value}/>)}
      {selected.length > 0 && <span className="exp-multi-tags" aria-label={`已选${itemLabel}`}>{selected.map(option => <span key={option.value} className={`exp-multi-tag ${option.disabled ? "unavailable" : ""}`}><span>{option.label}</span><button type="button" aria-label={`移除${option.label}`} disabled={disabled} onClick={() => onValuesChange(values.filter(value => value !== option.value))}><X size={11}/></button></span>)}</span>}
    </span>
    <Popover.Portal container={portalContainer}><Popover.Content ref={popup} id={popupId} align="start" sideOffset={7} collisionPadding={16} className="exp-multi-popup" data-exp-select-popup="" aria-label={menuLabel} onEscapeKeyDown={event => event.stopPropagation()}>
      <div className="exp-multi-heading"><div><strong>{menuLabel}</strong><small>{Number.isFinite(limit) ? atLimit ? `最多 ${limit} ${unit}，更换${itemLabel}请先取消已选` : selectionHint || `最多选择 ${limit} ${unit}合格${itemLabel}` : selectionHint || "可同时选择多位合格教练"}</small></div><button type="button" disabled={disabled || !available.length} onClick={selectAvailable}>{selectionFilled ? "清空选择" : available.length > limit ? `选满 ${limit} ${unit}` : "全选可用"}</button></div>
      <div className="exp-multi-options" role="group" aria-label={`${itemLabel}选项`}>{options.length ? options.map(option => <button key={option.value} type="button" role="checkbox" aria-checked={values.includes(option.value)} disabled={disabled || (!values.includes(option.value) && (option.disabled || atLimit))} className="exp-multi-option" onKeyDown={moveFocus} onClick={() => toggle(option.value)}>
        <span className="exp-multi-box">{values.includes(option.value) && <Check size={12}/>}</span><span className="exp-multi-option-copy"><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>{option.disabled ? <span className="exp-multi-status">暂不可选</span> : atLimit && !values.includes(option.value) && <span className="exp-multi-status">已达上限</span>}
      </button>) : <div className="exp-multi-empty">{emptyMessage}</div>}</div>
      <div className="exp-multi-footer"><span aria-live="polite">已选择 {selected.length}{Number.isFinite(limit) ? ` / ${limit}` : ""} {unit}{itemLabel}</span><button type="button" onClick={() => setOpen(false)}>完成选择<Check size={12}/></button></div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
