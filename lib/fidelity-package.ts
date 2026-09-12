import JSZip from 'jszip';

/** Reads data entries only; scripts in an external archive are never executed. */
export async function readFidelityArchive(bytes: Buffer) {
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files).filter(entry => !entry.dir && !entry.name.startsWith('__MACOSX/'));
  if (entries.length > 250) throw new Error('清洗包文件过多，请仅打包本剧清洗结果。');
  const limit = 20 * 1024 * 1024;
  let total = 0;
  const read = async (entry: JSZip.JSZipObject) => {
    const declared = (entry as unknown as {_data?:{uncompressedSize?:number}})._data?.uncompressedSize;
    if (declared && declared + total > limit) throw new Error('清洗包解压内容超过20MB。');
    const data = await entry.async('nodebuffer'); total += data.length;
    if (total > limit) throw new Error('清洗包解压内容超过20MB。');
    return data;
  };
  const candidates = entries.filter(entry => /(?:^|\/)(?:fidelity-import|reimport-source-plan)\.json$/i.test(entry.name));
  if (candidates.length > 1) throw new Error('压缩包包含多份回导结果，请每次仅上传一部剧的清洗包。');
  if (!candidates.length) {
    const texts = entries.filter(entry => /\.(txt|md|docx)$/i.test(entry.name) && !/(?:^|\/)(?:SKILL|README|contract|original-upload)|(?:report|references|scripts|baseline|original)\//i.test(entry.name));
    if (texts.length !== 1) throw new Error('包内未找到唯一清洗结果；可直接上传清洗后的TXT、MD或DOCX。');
    const originalEntries=entries.filter(entry=>/(?:^|\/)(?:original\/[^/]+|original-upload[^/]*)\.(?:docx|txt|md)$/i.test(entry.name));
    if(originalEntries.length>1)throw new Error('清洗包有多份原稿，无法确定配对。请仅保留对应原稿，或直接上传清洗文件。');
    const original=originalEntries.length===1?{name:originalEntries[0].name.split('/').at(-1)!,bytes:await read(originalEntries[0])}:undefined;
    return {name:texts[0].name.split('/').at(-1)!,bytes:await read(texts[0]),original};
  }
  const selected = candidates[0];
  const packageBytes = await read(selected);
  const root = selected.name.replace(/(?:output\/)?(?:fidelity-import|reimport-source-plan)\.json$/i, '');
  const originals = entries.filter(entry => entry.name.startsWith(root) && /(?:^|\/)(?:original\/[^/]+|original-upload[^/]*)\.(?:docx|txt|md)$/i.test(entry.name));
  if(originals.length>1)throw new Error('清洗包有多份原稿，无法确定配对。请仅保留对应原稿，或直接上传清洗文件。');
  const original = originals.length === 1 ? {name:originals[0].name.split('/').at(-1)!,bytes:await read(originals[0])} : undefined;
  return {name:selected.name.split('/').at(-1)!,bytes:packageBytes,original};
}
