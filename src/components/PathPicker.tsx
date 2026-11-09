// 路径选择卡片（0.3.0）：点击弹系统选择框（目录或 .zam 文件），替代手敲长路径的文本输入。
// 值只读展示（等宽字体换行）；选择取消不改动；演示模式由 mock 层返回演示路径。
import { useId } from "react";
import { IconFile, IconFolder } from "./icons";
import { pickDirectory, pickPackage } from "../lib/mock";

interface PathPickerProps {
  /** dir=选文件夹；file=选 .zam 迁移包文件。 */
  kind: "dir" | "file";
  /** 可见字段标签（同时作为按钮的可访问名称）。 */
  label: string;
  value: string;
  placeholder?: string;
  /** 选中（未取消）时回调新路径。 */
  onPick: (next: string) => void;
  hint?: string;
}

export function PathPicker(props: PathPickerProps) {
  const id = useId();
  const choose = async () => {
    const current = props.value.trim() || undefined;
    const next =
      props.kind === "dir" ? await pickDirectory(current) : await pickPackage(current);
    if (next) props.onPick(next);
  };
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {props.label}
      </label>
      <button id={id} type="button" className="path-picker" onClick={choose}>
        <span className="path-picker-icon" aria-hidden="true">
          {props.kind === "dir" ? <IconFolder size={18} /> : <IconFile size={18} />}
        </span>
        <span className={`path-picker-value${props.value ? "" : " empty"}`}>
          {props.value || props.placeholder || "点击选择…"}
        </span>
        <span className="path-picker-action" aria-hidden="true">
          {props.kind === "dir" ? "选择文件夹" : "选择文件"}
        </span>
      </button>
      {props.hint ? <p className="field-hint">{props.hint}</p> : null}
    </div>
  );
}
