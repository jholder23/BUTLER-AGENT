import React, { useMemo } from 'react';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';

const modules = {
  toolbar: [
    [{ header: [1, 2, 3, false] }],
    ['bold', 'italic', 'underline', 'strike'],
    [{ list: 'ordered' }, { list: 'bullet' }],
    [{ align: [] }],
    ['clean'],
  ],
};

const formats = [
  'header',
  'bold',
  'italic',
  'underline',
  'strike',
  'list',
  'bullet',
  'align',
];

export function ResumeRichEditor({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const mods = useMemo(() => modules, []);
  return (
    <div className={className ? `resume-rich-editor ${className}` : 'resume-rich-editor'}>
      <ReactQuill
        theme="snow"
        value={value}
        onChange={onChange}
        modules={mods}
        formats={formats}
        placeholder={placeholder}
      />
    </div>
  );
}
