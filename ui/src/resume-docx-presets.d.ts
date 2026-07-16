declare module '@resume-docx-presets' {
  const presets: {
    defaultStyleId: string;
    styles: Array<{
      id: string;
      name: string;
      blurb: string;
      preview: { bg: string; accent: string; text: string; bar: string };
    }>;
  };
  export default presets;
}
