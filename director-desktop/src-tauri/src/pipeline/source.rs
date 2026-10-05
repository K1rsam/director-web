use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::sync::OnceLock;

pub fn digest(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceRange {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceDialogue {
    pub id: String,
    pub speaker: String,
    pub channel: String,
    pub quote: String,
    pub range: SourceRange,
    #[serde(default)]
    pub spoken_segments: Vec<SourceSegment>,
    #[serde(default)]
    pub performance_segments: Vec<SourceSegment>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceSegment {
    pub text: String,
    pub range: SourceRange,
}

pub fn spoken_text(dialogue: &SourceDialogue) -> String {
    dialogue
        .spoken_segments
        .iter()
        .map(|part| part.text.as_str())
        .collect()
}

// Bracketed directions outside literal quotation are separate source evidence,
// never invented text. Nested brackets remain one complete outer segment.
fn bracket_segments(text: &str, origin: usize) -> Vec<SourceSegment> {
    let mut parts = Vec::new();
    let mut stack = Vec::new();
    let mut begin = 0;
    let mut quotation = None;
    for (byte, ch) in text.char_indices() {
        if stack.is_empty() {
            match ch {
                '“' | '「' | '『' if quotation.is_none() => {
                    quotation = Some(match ch {
                        '“' => '”',
                        '「' => '」',
                        _ => '』',
                    });
                    continue;
                }
                '"' if quotation.is_none() => {
                    quotation = Some('"');
                    continue;
                }
                _ if quotation == Some(ch) => {
                    quotation = None;
                    continue;
                }
                _ if quotation.is_some() => continue,
                _ => {}
            }
        }
        let close = match ch {
            '（' => Some('）'),
            '(' => Some(')'),
            '[' => Some(']'),
            '【' => Some('】'),
            _ => None,
        };
        if let Some(close) = close {
            if stack.is_empty() {
                begin = byte;
            }
            stack.push(close);
        } else if stack.last() == Some(&ch) {
            stack.pop();
            if stack.is_empty() {
                let end = byte + ch.len_utf8();
                parts.push(SourceSegment {
                    text: text[begin..end].into(),
                    range: SourceRange {
                        start: origin + text[..begin].encode_utf16().count(),
                        end: origin + text[..end].encode_utf16().count(),
                    },
                });
            }
        }
    }
    parts
}

fn dialogue_segments(
    line: &str,
    start: usize,
    quote_start: usize,
    quote_range: &SourceRange,
) -> (Vec<SourceSegment>, Vec<SourceSegment>) {
    let mut performance = bracket_segments(&line[..quote_start], start);
    let inline = bracket_segments(&line[quote_start..], quote_range.start);
    let mut spoken = Vec::new();
    let mut cursor = quote_range.start;
    for cue in &inline {
        if cursor < cue.range.start {
            let range = SourceRange {
                start: cursor,
                end: cue.range.start,
            };
            spoken.push(SourceSegment {
                text: slice_utf16(
                    line,
                    &SourceRange {
                        start: range.start - start,
                        end: range.end - start,
                    },
                )
                .unwrap(),
                range,
            });
        }
        cursor = cue.range.end;
    }
    if cursor < quote_range.end {
        let range = SourceRange {
            start: cursor,
            end: quote_range.end,
        };
        spoken.push(SourceSegment {
            text: slice_utf16(
                line,
                &SourceRange {
                    start: range.start - start,
                    end: range.end - start,
                },
            )
            .unwrap(),
            range,
        });
    }
    performance.extend(inline);
    (spoken, performance)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRow {
    pub id: String,
    pub number: usize,
    pub range: SourceRange,
    pub text: String,
    pub kind: String,
    pub episode_id: Option<String>,
    pub scene_id: Option<String>,
    pub dialogue: Option<SourceDialogue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceEpisode {
    pub id: String,
    pub number: u32,
    pub source_number: String,
    pub title: String,
    pub row_ids: Vec<String>,
    pub scene_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceScene {
    pub id: String,
    pub episode_id: String,
    pub title: String,
    pub row_ids: Vec<String>,
    #[serde(default, flatten)]
    pub metadata: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceDiagnostic {
    pub code: String,
    pub row_ids: Vec<String>,
    pub message: String,
    pub blocking: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockedSource {
    pub schema_version: String,
    /// Missing on earlier saved sources: their original classification contract
    /// stays valid until the user explicitly requests recognition again.
    #[serde(default = "legacy_parser_version")]
    pub parser_version: String,
    pub text: String,
    pub sha256: String,
    pub coordinate_system: String,
    pub length: usize,
    pub rows: Vec<SourceRow>,
    pub episodes: Vec<SourceEpisode>,
    pub scenes: Vec<SourceScene>,
    pub diagnostics: Vec<SourceDiagnostic>,
    #[serde(default)]
    pub boundary_decisions: Vec<BoundaryDecision>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scene_edits: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundaryDecision {
    pub start: usize,
    pub end: usize,
    pub kind: String,
    pub episode_number: Option<u32>,
    pub scene_title: Option<String>,
    pub reason: String,
}

const LEGACY_PARSER_VERSION: &str = "source-parser/v1";
const CURRENT_PARSER_VERSION: &str = "source-parser/v2";

fn legacy_parser_version() -> String {
    LEGACY_PARSER_VERSION.into()
}

fn context_heading(line: &str, inline_allowed: bool) -> bool {
    let line = line.trim();
    let hashes = line.chars().take_while(|c| *c == '#').count();
    let line = if (1..=6).contains(&hashes) {
        line[hashes..].trim_start()
    } else {
        line
    };
    let (title, suffix) = line.split_once([':', '：']).unwrap_or((line, ""));
    if !suffix.trim().is_empty() && !inline_allowed {
        return false;
    }
    let title = title.trim();
    let title = [('【', '】'), ('[', ']'), ('（', '）'), ('(', ')')]
        .iter()
        .find_map(|(open, close)| title.strip_prefix(*open)?.strip_suffix(*close))
        .unwrap_or(title)
        .trim();
    [
        "作者资料",
        "故事大纲",
        "故事简介",
        "剧情简介",
        "内容简介",
        "剧本简介",
        "人物关系",
        "人物小传",
        "人物设定",
        "角色小传",
        "角色设定",
        "角色关系",
        "世界观",
        "世界观设定",
        "背景资料",
        "背景设定",
        "段纲",
        "分集大纲",
        "附录",
    ]
    .contains(&title)
}

pub fn slice_utf16(text: &str, range: &SourceRange) -> Result<String, String> {
    if range.end < range.start {
        return Err("来源区间结束早于开始".into());
    }
    let mut offset = 0;
    let mut start = None;
    let mut end = None;
    for (byte, ch) in text.char_indices() {
        if offset == range.start {
            start = Some(byte);
        }
        if offset == range.end {
            end = Some(byte);
        }
        offset += ch.len_utf16();
    }
    if offset == range.start {
        start = Some(text.len());
    }
    if offset == range.end {
        end = Some(text.len());
    }
    match (start, end) {
        (Some(a), Some(b)) => Ok(text[a..b].to_string()),
        _ => Err("来源区间越界或切入 UTF-16 代理对".into()),
    }
}

fn raw_lines(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let (mut cursor, mut start) = (0, 0);
    let mut rows = Vec::new();
    while cursor < bytes.len() {
        match bytes[cursor] {
            b'\r' => {
                cursor += 1;
                if bytes.get(cursor) == Some(&b'\n') {
                    cursor += 1;
                }
                rows.push(&text[start..cursor]);
                start = cursor;
            }
            b'\n' => {
                cursor += 1;
                rows.push(&text[start..cursor]);
                start = cursor;
            }
            _ => cursor += 1,
        }
    }
    if start < text.len() {
        rows.push(&text[start..]);
    }
    rows
}

fn number_value(value: &str) -> Option<u32> {
    if let Ok(number) = value.parse() {
        return Some(number);
    }
    let (mut total, mut digit) = (0_u32, 0_u32);
    for ch in value.chars() {
        match ch {
            '零' | '〇' => digit = 0,
            '一' => digit = 1,
            '二' | '两' => digit = 2,
            '三' => digit = 3,
            '四' => digit = 4,
            '五' => digit = 5,
            '六' => digit = 6,
            '七' => digit = 7,
            '八' => digit = 8,
            '九' => digit = 9,
            '十' => {
                total += digit.max(1) * 10;
                digit = 0;
            }
            '百' => {
                total += digit.max(1) * 100;
                digit = 0;
            }
            '千' => {
                total += digit.max(1) * 1000;
                digit = 0;
            }
            _ => return None,
        }
    }
    Some(total + digit)
}

fn parse_dialogue(text: &str, start: usize, row_id: &str) -> Option<SourceDialogue> {
    let line = text.trim_end_matches(['\r', '\n']);
    // Only an explicit leading label is a lexical speaker; no colon inference inside a sentence.
    let mut depth = 0_i32;
    let mut colon = None;
    for (byte, ch) in line.char_indices() {
        match ch {
            '（' | '(' | '[' | '【' => depth += 1,
            '）' | ')' | ']' | '】' => depth -= 1,
            ':' | '：' if depth == 0 => {
                colon = Some(byte);
                break;
            }
            _ => {}
        }
        if depth < 0 || byte > 256 {
            return None;
        }
    }
    let colon = colon?;
    let head = line[..colon].trim();
    static HEAD: OnceLock<Regex> = OnceLock::new();
    let re = HEAD.get_or_init(|| Regex::new(r"^([\p{L}\p{N}·・_]{1,24})(.*)$").unwrap());
    let captures = re.captures(head)?;
    let label = captures.get(1)?.as_str();
    if !label.chars().any(char::is_alphabetic) {
        return None;
    }
    if [
        "场景",
        "地点",
        "时间",
        "时刻",
        "人物",
        "出场人物",
        "道具",
        "旁注",
        "备注",
        "画面",
        "声音",
    ]
    .contains(&label)
    {
        return None;
    }
    let tail = captures.get(2).map(|m| m.as_str()).unwrap_or("");
    let mut hint = String::new();
    let mut channel_text = String::new();
    let mut hint_depth = 0_i32;
    for ch in tail.chars() {
        match ch {
            '（' | '(' | '[' | '【' => hint_depth += 1,
            '）' | ')' | ']' | '】' => hint_depth -= 1,
            _ if hint_depth > 0 => hint.push(ch),
            _ if !ch.is_whitespace() => channel_text.push(ch),
            _ => {}
        }
    }
    if hint_depth != 0 || !["", "OS", "VO", "O.S.", "V.O."].contains(&channel_text.as_str()) {
        return None;
    }
    let suffix = channel_text.as_str();
    let (speaker, channel) = if label.ends_with("OS") && label.chars().count() > 2 {
        (&label[..label.len() - 2], "OS")
    } else if label.ends_with("VO") && label.chars().count() > 2 {
        (&label[..label.len() - 2], "VO")
    } else if label == "旁白" {
        (label, "VO")
    } else if ["系统", "系统音"].contains(&label) {
        (label, "系统音")
    } else if suffix.contains('O') && !suffix.starts_with('V') || hint.contains("OS") {
        (label, "OS")
    } else if suffix.starts_with('V') || hint.contains("VO") {
        (label, "VO")
    } else if hint.contains("画外") {
        (label, "画外")
    } else {
        (label, "现场")
    };
    let after_colon = colon + line[colon..].chars().next()?.len_utf8();
    let quote_start =
        after_colon + line[after_colon..].len() - line[after_colon..].trim_start().len();
    let quote = &line[quote_start..];
    if quote.is_empty() {
        return None;
    }
    let a = start + line[..quote_start].encode_utf16().count();
    let range = SourceRange {
        start: a,
        end: a + quote.encode_utf16().count(),
    };
    let (spoken_segments, performance_segments) =
        dialogue_segments(line, start, quote_start, &range);
    Some(SourceDialogue {
        id: format!("dialogue:{row_id}"),
        speaker: speaker.into(),
        channel: channel.into(),
        quote: quote.into(),
        range,
        spoken_segments,
        performance_segments,
    })
}

pub fn prepare_source(text: &str) -> Result<LockedSource, String> {
    let source = parse_source(text, CURRENT_PARSER_VERSION)?;
    validate_integrity(&source)?;
    Ok(source)
}

fn parse_source(text: &str, parser_version: &str) -> Result<LockedSource, String> {
    if text.is_empty() {
        return Err("原文不能为空".into());
    }
    if ![LEGACY_PARSER_VERSION, CURRENT_PARSER_VERSION].contains(&parser_version) {
        return Err("原文解析规则版本不受支持，请升级客户端".into());
    }
    let sha256 = digest(text);
    let episode_re = Regex::new(
        r"^(?:#{1,6}\s*)?第\s*([零〇一二三四五六七八九十百千两\d]+)\s*集(?:\s|[:：｜|—-]|$)(.*)$",
    )
    .unwrap();
    let context_re = Regex::new(r"^(?:#{1,6}\s*)?(?:【)?(?:作者资料|故事大纲|人物小传|人物设定|世界观设定|背景资料|附录)(?:】)?(?:\s|[:：｜|]|$)").unwrap();
    let is_context = |line: &str, inline_allowed: bool| {
        if parser_version == LEGACY_PARSER_VERSION {
            context_re.is_match(line)
        } else {
            context_heading(line, inline_allowed)
        }
    };
    let scene_re = Regex::new(r"^(?:#{1,6}\s*)?(?:第\s*([零〇一二三四五六七八九十百千两\d]+)\s*场(?:\s|[:：｜|]|$)|场景(?:\s*[:：]\s*|\s+)(\S.*))").unwrap();
    let pair_re = Regex::new(r"^(?:#{1,6}\s*)?(?:场\s*)?(\d+)\s*[-－.．]\s*(\d+)\s+(.+)$").unwrap();
    let bare_pair_re =
        Regex::new(r"^(?:#{1,6}\s*)?(?:场\s*)?(\d+)\s*[-－]\s*(\d+)\s*[:：]?$").unwrap();
    let combined_re = Regex::new(r"^(.*?)\s*场\s*(\d+)\s*[-－.．]\s*(\d+)\s+(.+)$").unwrap();
    let metadata_re = Regex::new(r"(?:^|[\s/／|｜])(?:日|夜|昼|晨|黄昏|清晨|凌晨|傍晚|白天|夜晚|内|外|内景|外景|INT\.?|EXT\.?)(?:$|[\s/／|｜])").unwrap();
    let time_re = Regex::new(
        r"(?:^|[\s/／|｜])(?:日|夜|昼|晨|黄昏|清晨|凌晨|傍晚|白天|夜晚)(?:$|[\s/／|｜])",
    )
    .unwrap();
    let location_re =
        Regex::new(r"(?:^|[\s/／|｜])(?:内|外|内景|外景|INT\.?|EXT\.?)(?:$|[\s/／|｜])").unwrap();
    let mut source = LockedSource {
        schema_version: "locked-source/v1".into(),
        parser_version: parser_version.into(),
        text: text.into(),
        sha256: sha256.clone(),
        coordinate_system: "utf16".into(),
        length: text.encode_utf16().count(),
        rows: Vec::new(),
        episodes: Vec::new(),
        scenes: Vec::new(),
        diagnostics: Vec::new(),
        boundary_decisions: Vec::new(),
        scene_edits: Vec::new(),
    };
    let (mut offset, mut episode_id, mut scene_id, mut context, mut source_number) =
        (0, None, None, false, None);
    let mut seen = HashSet::new();
    let mut continued_metadata = HashSet::new();
    let lines = raw_lines(text);
    let first_nonempty = lines.iter().position(|line| !line.trim().is_empty());
    for (index, raw) in lines.iter().enumerate() {
        let line = raw.trim();
        let end = offset + raw.encode_utf16().count();
        let id = format!("row:{}:{offset}:{end}", &sha256[..12]);
        let mut kind = if line.is_empty() {
            "format"
        } else if context {
            "context"
        } else {
            "body"
        };
        let title_before_context = Some(index) == first_nonempty
            && line.chars().count() <= 60
            && !line.contains(['。', '！', '？', '!', '?', '△', '▲', '：', ':', '“', '”'])
            && lines
                .iter()
                .skip(index + 1)
                .find(|s| !s.trim().is_empty())
                .map(|next| is_context(next.trim(), true))
                .unwrap_or(false);
        if let Some(c) = episode_re.captures(line) {
            let number = number_value(c.get(1).unwrap().as_str()).ok_or("无法识别原集号")?;
            let title = c.get(2).map(|m| m.as_str()).unwrap_or("");
            let next_is_context = lines
                .iter()
                .skip(index + 1)
                .find(|s| !s.trim().is_empty())
                .map(|s| is_context(s.trim(), true))
                .unwrap_or(false);
            context = is_context(title.trim(), true)
                || number == 0 && title.trim().is_empty() && next_is_context;
            scene_id = None;
            source_number = Some(number);
            if context {
                episode_id = None;
                kind = "context";
            } else {
                let eid = format!("episode:{}:{offset}", &sha256[..12]);
                if !seen.insert(number) {
                    source.diagnostics.push(SourceDiagnostic {
                        code: "DUPLICATE_EPISODE_NUMBER".into(),
                        row_ids: vec![id.clone()],
                        message: "原集号重复，保留两处来源，需明确制作范围".into(),
                        blocking: true,
                    });
                }
                if number == 0 && title.trim().is_empty() {
                    source.diagnostics.push(SourceDiagnostic {
                        code: "ZERO_EPISODE_UNCONFIRMED".into(),
                        row_ids: vec![id.clone()],
                        message: "第0集未声明资料或序章剧情，需确认".into(),
                        blocking: true,
                    });
                }
                source.episodes.push(SourceEpisode {
                    id: eid.clone(),
                    number: source.episodes.len() as u32 + 1,
                    source_number: c.get(1).unwrap().as_str().into(),
                    title: line.into(),
                    row_ids: vec![],
                    scene_ids: vec![],
                });
                episode_id = Some(eid);
                kind = "format";
                if let Some(combined) = combined_re.captures(title).filter(|c| {
                    c.get(1).unwrap().as_str().chars().count() <= 80
                        && !c
                            .get(1)
                            .unwrap()
                            .as_str()
                            .contains(['。', '！', '？', '△', '▲', ':', '：'])
                        && c.get(3).unwrap().as_str().parse::<u32>().unwrap_or(0) > 0
                        && metadata_re.is_match(c.get(4).unwrap().as_str())
                }) {
                    if combined.get(2).unwrap().as_str().parse::<u32>().ok() == Some(number) {
                        let sid = format!("scene:{}:{offset}", &sha256[..12]);
                        let eid = episode_id.as_ref().unwrap();
                        source.scenes.push(SourceScene {
                            id: sid.clone(),
                            episode_id: eid.clone(),
                            title: combined.get(0).unwrap().as_str().into(),
                            row_ids: vec![],
                            metadata: Default::default(),
                        });
                        source
                            .episodes
                            .last_mut()
                            .unwrap()
                            .scene_ids
                            .push(sid.clone());
                        scene_id = Some(sid);
                    } else {
                        source.diagnostics.push(SourceDiagnostic {
                            code: "SCENE_EPISODE_MISMATCH".into(),
                            row_ids: vec![id.clone()],
                            message: "同行场号与集号不一致；原行完整保留".into(),
                            blocking: true,
                        });
                    }
                }
            }
        } else if is_context(line, episode_id.is_none() || context) {
            context = true;
            episode_id = None;
            scene_id = None;
            kind = "context";
        } else if ["序章", "序幕"].iter().any(|p| {
            line == *p || line.starts_with(&format!("{p}：")) || line.starts_with(&format!("{p} "))
        }) {
            let eid = format!("episode:{}:{offset}", &sha256[..12]);
            source.episodes.push(SourceEpisode {
                id: eid.clone(),
                number: source.episodes.len() as u32 + 1,
                source_number: "序章".into(),
                title: line.into(),
                row_ids: vec![],
                scene_ids: vec![],
            });
            context = false;
            episode_id = Some(eid);
            scene_id = None;
            kind = "format";
        } else if !context {
            let scene = scene_re.captures(line);
            let explicit_location = scene.as_ref().and_then(|c| c.get(2)).map(|m| m.as_str());
            let valid_location = explicit_location
                .map(|s| {
                    s.chars().count() <= 160
                        && !s.contains(['：', ':', '△', '▲', '。', '！', '？', '“', '”'])
                })
                .unwrap_or(true);
            let pair = pair_re.captures(line);
            let bare = bare_pair_re.captures(line);
            let following = if bare.is_some() {
                lines
                    .iter()
                    .enumerate()
                    .skip(index + 1)
                    .find(|(_, s)| !s.trim().is_empty())
            } else {
                None
            };
            let separate_metadata = bare
                .as_ref()
                .map(|c| c.get(2).unwrap().as_str().parse::<u32>().unwrap_or(0) > 0)
                .unwrap_or(false)
                && following
                    .map(|(_, s)| {
                        s.trim().chars().count() <= 160
                            && !s.contains(['：', ':', '△', '▲', '。', '！', '？', '“', '”'])
                            && time_re.is_match(s.trim())
                            && location_re.is_match(s.trim())
                            && !episode_re.is_match(s.trim())
                    })
                    .unwrap_or(false);
            let separate_matches = separate_metadata
                && bare
                    .as_ref()
                    .unwrap()
                    .get(1)
                    .unwrap()
                    .as_str()
                    .parse::<u32>()
                    .ok()
                    == source_number;
            let has_metadata = pair
                .as_ref()
                .map(|c| {
                    c.get(2).unwrap().as_str().parse::<u32>().unwrap_or(0) > 0
                        && metadata_re.is_match(c.get(3).unwrap().as_str())
                })
                .unwrap_or(false);
            let mismatch = pair
                .as_ref()
                .filter(|_| has_metadata)
                .map(|c| c.get(1).unwrap().as_str().parse::<u32>().ok() != source_number)
                .unwrap_or(false)
                || separate_metadata && !separate_matches;
            if mismatch {
                source.diagnostics.push(SourceDiagnostic {
                    code: "SCENE_EPISODE_MISMATCH".into(),
                    row_ids: vec![id.clone()],
                    message: "场号所属集与当前集不同，未自动归属".into(),
                    blocking: true,
                });
                scene_id = None;
            } else if scene.is_some() && valid_location || has_metadata || separate_matches {
                if let Some(eid) = &episode_id {
                    let sid = format!("scene:{}:{offset}", &sha256[..12]);
                    source.scenes.push(SourceScene {
                        id: sid.clone(),
                        episode_id: eid.clone(),
                        title: line.into(),
                        row_ids: vec![],
                        metadata: Default::default(),
                    });
                    source
                        .episodes
                        .iter_mut()
                        .find(|e| &e.id == eid)
                        .unwrap()
                        .scene_ids
                        .push(sid.clone());
                    scene_id = Some(sid);
                    if separate_matches {
                        continued_metadata.insert(following.unwrap().0);
                    }
                    // Inline source action remains body; otherwise scene metadata is format only.
                    kind = if line.contains(['△', '▲'])
                        || parse_dialogue(
                            line.split_once(['△', '▲']).map(|(_, t)| t).unwrap_or(""),
                            0,
                            "",
                        )
                        .is_some()
                    {
                        "body"
                    } else {
                        "format"
                    };
                }
            }
        }
        if continued_metadata.contains(&index) && !context {
            kind = "format";
        }
        if title_before_context {
            kind = "context";
        }
        if kind == "body" && (episode_id.is_none() || scene_id.is_none()) {
            let code = if episode_id.is_some() {
                "SCENE_BOUNDARY_UNCONFIRMED"
            } else {
                "BOUNDARY_UNCONFIRMED"
            };
            if let Some(last) = source.diagnostics.last_mut().filter(|d| d.code == code) {
                last.row_ids.push(id.clone());
            } else {
                source.diagnostics.push(SourceDiagnostic {
                    code: code.into(),
                    row_ids: vec![id.clone()],
                    message: "原文已完整保留；请对待定正文给出明确集场范围".into(),
                    blocking: true,
                });
            }
        }
        let dialogue = if kind == "body" {
            parse_dialogue(raw, offset, &id)
        } else {
            None
        };
        if let Some(eid) = &episode_id {
            if let Some(e) = source.episodes.iter_mut().find(|e| &e.id == eid) {
                e.row_ids.push(id.clone());
            }
        }
        if let Some(sid) = &scene_id {
            if let Some(s) = source.scenes.iter_mut().find(|s| &s.id == sid) {
                s.row_ids.push(id.clone());
            }
        }
        source.rows.push(SourceRow {
            id,
            number: index + 1,
            range: SourceRange { start: offset, end },
            text: (*raw).into(),
            kind: kind.into(),
            episode_id: episode_id.clone(),
            scene_id: scene_id.clone(),
            dialogue,
        });
        offset = end;
    }
    let speaker_names: HashSet<_> = source
        .rows
        .iter()
        .filter_map(|r| r.dialogue.as_ref().map(|q| q.speaker.clone()))
        .collect();
    let inline_re = Regex::new(
        r"(?:^|[\s；;])([\p{L}][\p{L}\p{N}·・_]{0,23})(?:\s*[（(][^\r\n:：()（）]*[）)])?\s*[:：]",
    )
    .unwrap();
    for row in &source.rows {
        if let Some(q) = &row.dialogue {
            if inline_re
                .captures_iter(&q.quote)
                .any(|c| speaker_names.contains(c.get(1).unwrap().as_str()))
            {
                source.diagnostics.push(SourceDiagnostic{code:"DIALOGUE_MULTI_SPEAKER_UNCONFIRMED".into(),row_ids:vec![row.id.clone()],message:"同一原行含多个明确说者，保留原行；需按原坐标明确对白分段，不能把后段读给首位说者".into(),blocking:true});
            }
        }
    }
    Ok(source)
}

pub(super) fn source_before_scene_edits(source: &LockedSource) -> Result<LockedSource, String> {
    let canonical = parse_source(&source.text, &source.parser_version)?;
    if source.boundary_decisions.is_empty() { Ok(canonical) }
    else { apply_decisions_inner(&canonical, &source.boundary_decisions) }
}

pub fn validate_source(source: &LockedSource) -> Result<(), String> {
    validate_integrity(source)?;
    let canonical = parse_source(&source.text, &source.parser_version)?;
    let expected = if source.boundary_decisions.is_empty() {
        canonical
    } else {
        apply_decisions_inner(&canonical, &source.boundary_decisions)?
    };
    let expected=super::scene_edits::replay_scene_edits(expected,&source.scene_edits)?;
    let mut rows = source.rows.clone();
    for (row, expected) in rows.iter_mut().zip(&expected.rows) {
        if let (Some(actual), Some(expected)) = (&mut row.dialogue, &expected.dialogue) {
            if actual.spoken_segments.is_empty() && actual.performance_segments.is_empty() {
                actual.spoken_segments = expected.spoken_segments.clone();
                actual.performance_segments = expected.performance_segments.clone();
            }
        }
    }
    if serde_json::to_value(&rows).unwrap() != serde_json::to_value(&expected.rows).unwrap()
        || serde_json::to_value(&source.episodes).unwrap()
            != serde_json::to_value(&expected.episodes).unwrap()
        || serde_json::to_value(&source.scenes).unwrap()
            != serde_json::to_value(&expected.scenes).unwrap()
        || serde_json::to_value(&source.diagnostics).unwrap()
            != serde_json::to_value(&expected.diagnostics).unwrap()
    {
        return Err("来源分类、说者、集场或疑点不匹配程序解析与已保存显式决定".into());
    }
    Ok(())
}

/// Old saved sources can omit the new segments. Validate their original contract
/// first, then materialize every new field from the same locked text/decisions.
pub fn upgrade_source_dialogues(source: &LockedSource) -> Result<LockedSource, String> {
    validate_source(source)?;
    let canonical = parse_source(&source.text, &source.parser_version)?;
    let out=if source.boundary_decisions.is_empty() {
        Ok(canonical)
    } else {
        apply_decisions_inner(&canonical, &source.boundary_decisions)
    }?;
    super::scene_edits::replay_scene_edits(out,&source.scene_edits)
}

/// Recognition changes only deterministic classifications. Raw text, source
/// coordinates, and all explicit user decisions retain their original identity.
pub fn reparse_source(source: &LockedSource) -> Result<LockedSource, String> {
    validate_source(source)?;
    let canonical = parse_source(&source.text, CURRENT_PARSER_VERSION)?;
    let out = if source.boundary_decisions.is_empty() {
        canonical
    } else {
        apply_decisions_inner(&canonical, &source.boundary_decisions)?
    };
    let out=super::scene_edits::replay_scene_edits(out,&source.scene_edits)?;
    validate_source(&out)?;
    Ok(out)
}

fn validate_integrity(source: &LockedSource) -> Result<(), String> {
    if source.schema_version != "locked-source/v1"
        || source.coordinate_system != "utf16"
        || source.sha256 != digest(&source.text)
        || source.length != source.text.encode_utf16().count()
    {
        return Err("原文或来源元数据已变更".into());
    }
    let mut cursor = 0;
    let mut ids = HashSet::new();
    let mut reconstructed = String::new();
    for row in &source.rows {
        if row.range.start != cursor
            || row.range.end <= cursor
            || !ids.insert(&row.id)
            || slice_utf16(&source.text, &row.range)? != row.text
        {
            return Err("来源行存在遗漏、重叠、错序或回读不一致".into());
        }
        let expected_dialogue = if row.kind == "body" {
            parse_dialogue(&row.text, row.range.start, &row.id)
        } else {
            None
        };
        let mut actual_dialogue = row.dialogue.clone();
        if let (Some(actual), Some(expected)) = (&mut actual_dialogue, &expected_dialogue) {
            if actual.spoken_segments.is_empty() && actual.performance_segments.is_empty() {
                actual.spoken_segments = expected.spoken_segments.clone();
                actual.performance_segments = expected.performance_segments.clone();
            }
        }
        if actual_dialogue != expected_dialogue {
            return Err("对白说者、声道、原片段或来源范围已变更".into());
        }
        if let Some(q) = &row.dialogue {
            if q.range.start < row.range.start
                || q.range.end > row.range.end
                || slice_utf16(&source.text, &q.range)? != q.quote
            {
                return Err("对白引用与原文不一致".into());
            }
        }
        if !["body", "context", "format"].contains(&row.kind.as_str()) {
            return Err("未知原文分类".into());
        }
        if row.kind == "body"
            && row.episode_id.is_some()
            && row.scene_id.is_some()
            && (!source
                .episodes
                .iter()
                .any(|e| Some(&e.id) == row.episode_id.as_ref() && e.row_ids.contains(&row.id))
                || !source.scenes.iter().any(|s| {
                    Some(&s.id) == row.scene_id.as_ref()
                        && Some(&s.episode_id) == row.episode_id.as_ref()
                        && s.row_ids.contains(&row.id)
                }))
        {
            return Err("原文集场身份或成员关联已失效".into());
        }
        reconstructed.push_str(&row.text);
        cursor = row.range.end;
    }
    if cursor != source.length || reconstructed != source.text {
        return Err("来源未完整覆盖到结尾".into());
    }
    Ok(())
}

pub fn apply_boundary_decisions(
    source: &LockedSource,
    decisions: &[BoundaryDecision],
) -> Result<LockedSource, String> {
    validate_source(source)?;
    let mut all = source.boundary_decisions.clone();
    for decision in decisions {
        // Replacing a previous whole decision is explicit and stored as a new source version by Store.
        all.retain(|old| !(old.start == decision.start && old.end == decision.end));
        all.push(decision.clone());
    }
    let mut out =
        apply_decisions_inner(&parse_source(&source.text, &source.parser_version)?, &all)?;
    out.boundary_decisions = all;
    let out=super::scene_edits::replay_scene_edits(out,&source.scene_edits)?;
    validate_source(&out)?;
    Ok(out)
}

fn apply_decisions_inner(
    source: &LockedSource,
    decisions: &[BoundaryDecision],
) -> Result<LockedSource, String> {
    let boundaries: HashSet<_> = source
        .rows
        .iter()
        .flat_map(|r| [r.range.start, r.range.end])
        .collect();
    for (i, d) in decisions.iter().enumerate() {
        if !boundaries.contains(&d.start)
            || !boundaries.contains(&d.end)
            || d.start >= d.end
            || d.reason.trim().is_empty()
            || !["body", "context"].contains(&d.kind.as_str())
            || decisions[..i]
                .iter()
                .any(|p| p.start < d.end && d.start < p.end)
        {
            return Err("范围决定必须完整行、无重叠且有明确原因".into());
        }
        if d.kind == "body"
            && (d.episode_number.is_none()
                || d.scene_title
                    .as_ref()
                    .map(|s| s.trim().is_empty())
                    .unwrap_or(true))
        {
            return Err("正文决定必须指定集号和场景".into());
        }
    }
    let mut out = source.clone();
    for d in decisions {
        let selected: Vec<_> = out
            .rows
            .iter()
            .filter(|r| r.range.start >= d.start && r.range.end <= d.end)
            .map(|r| r.id.clone())
            .collect();
        let eid = if d.kind == "body" {
            let candidates: Vec<_> = out
                .episodes
                .iter()
                .filter(|e| {
                    number_value(&e.source_number) == d.episode_number
                        && out.rows.iter().any(|r| {
                            selected.contains(&r.id) && r.episode_id.as_ref() == Some(&e.id)
                        })
                })
                .collect();
            Some(if candidates.len() == 1 {
                candidates[0].id.clone()
            } else {
                format!(
                    "episode:{}:decision:{}",
                    &out.sha256[..12],
                    d.episode_number.unwrap()
                )
            })
        } else {
            None
        };
        let sid = eid
            .as_ref()
            .map(|_| format!("scene:{}:decision:{}:{}", &out.sha256[..12], d.start, d.end));
        for row in out.rows.iter_mut().filter(|r| selected.contains(&r.id)) {
            row.kind = d.kind.clone();
            row.episode_id = eid.clone();
            row.scene_id = sid.clone();
            row.dialogue = if d.kind == "body" {
                parse_dialogue(&row.text, row.range.start, &row.id)
            } else {
                None
            };
        }
        out.diagnostics.retain_mut(|issue| {
            if [
                "BOUNDARY_UNCONFIRMED",
                "SCENE_BOUNDARY_UNCONFIRMED",
                "ZERO_EPISODE_UNCONFIRMED",
                "SCENE_EPISODE_MISMATCH",
                "DUPLICATE_EPISODE_NUMBER",
            ]
            .contains(&issue.code.as_str())
            {
                issue.row_ids.retain(|id| !selected.contains(id));
            }
            !issue.row_ids.is_empty()
        });
        if let (Some(eid), Some(sid)) = (eid, sid) {
            if !out.episodes.iter().any(|e| e.id == eid) {
                out.episodes.push(SourceEpisode {
                    id: eid.clone(),
                    number: d.episode_number.unwrap(),
                    source_number: d.episode_number.unwrap().to_string(),
                    title: format!("第{}集", d.episode_number.unwrap()),
                    row_ids: vec![],
                    scene_ids: vec![],
                });
            }
            out.scenes.push(SourceScene {
                id: sid,
                episode_id: eid,
                title: d.scene_title.clone().unwrap(),
                row_ids: vec![],
                metadata: Default::default(),
            });
        }
    }
    // Rebuild memberships from current row assignments; never retain previous stale members.
    let row_groups: BTreeMap<String, Vec<String>> = out
        .rows
        .iter()
        .filter_map(|r| r.episode_id.as_ref().map(|id| (id.clone(), r.id.clone())))
        .fold(BTreeMap::new(), |mut m, (id, row)| {
            m.entry(id).or_default().push(row);
            m
        });
    for e in &mut out.episodes {
        e.row_ids = row_groups.get(&e.id).cloned().unwrap_or_default();
        e.scene_ids = out
            .scenes
            .iter()
            .filter(|s| {
                s.episode_id == e.id && out.rows.iter().any(|r| r.scene_id.as_ref() == Some(&s.id))
            })
            .map(|s| s.id.clone())
            .collect();
    }
    for s in &mut out.scenes {
        s.row_ids = out
            .rows
            .iter()
            .filter(|r| r.scene_id.as_ref() == Some(&s.id))
            .map(|r| r.id.clone())
            .collect();
    }
    out.episodes.retain(|e| !e.row_ids.is_empty());
    out.scenes.retain(|s| !s.row_ids.is_empty());
    out.boundary_decisions = decisions.to_vec();
    validate_integrity(&out)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_front_matter_is_context_and_existing_episode_scene_ids_stay_stable() {
        let text = "示例剧名\r\n【故事简介】\r\n主角来到新世界😀。\r\n【人物关系】\r\n姓名：苏远\r\n关系：男主\r\n【段纲】\r\n第一集发生重逢。\r\n\r\n第一集 重逢\r\n场景：门口\r\n苏远（低声）：回来😀。\r\n第二集\r\n2-1 夜 内 大厅\r\n苏远：门关了。\r\n";
        let legacy = parse_source(text, LEGACY_PARSER_VERSION).unwrap();
        let source = prepare_source(text).unwrap();
        assert_eq!(source.parser_version, CURRENT_PARSER_VERSION);
        assert!(source.diagnostics.is_empty());
        assert_eq!(source.episodes.len(), 2);
        assert_eq!(source.scenes.len(), 2);
        assert!(source.rows[..8].iter().all(|r| r.kind == "context"
            && r.episode_id.is_none()
            && r.scene_id.is_none()
            && r.dialogue.is_none()));
        assert_eq!(
            source
                .rows
                .iter()
                .map(|r| r.text.as_str())
                .collect::<String>(),
            text
        );
        assert_eq!(source.length, text.encode_utf16().count());
        assert_eq!(source.sha256, digest(text));
        assert_eq!(
            source.episodes.iter().map(|e| &e.id).collect::<Vec<_>>(),
            legacy.episodes.iter().map(|e| &e.id).collect::<Vec<_>>()
        );
        assert_eq!(
            source.scenes.iter().map(|s| &s.id).collect::<Vec<_>>(),
            legacy.scenes.iter().map(|s| &s.id).collect::<Vec<_>>()
        );
        for row in &source.rows {
            assert_eq!(slice_utf16(text, &row.range).unwrap(), row.text);
        }
        let dialogue = source.rows[11].dialogue.as_ref().unwrap();
        assert_eq!(dialogue.speaker, "苏远");
        assert_eq!(dialogue.quote, "回来😀。");
        validate_source(&source).unwrap();
    }

    #[test]
    fn background_titles_are_explicit_not_nearby_body_wording() {
        for heading in [
            "故事简介",
            "【剧情简介】",
            "[人物关系]",
            "（作者资料）",
            "(人物小传)",
            "## 世界观",
            "【段纲】：",
        ] {
            assert!(context_heading(heading, false), "{heading}");
        }
        for body in [
            "故事简介中的主角走来。",
            "人物关系已经改变。",
            "【故事简介】不像实际剧情",
            "【人物关系)",
            "苏远：故事简介。",
            "故事大纲 不是一句标题。",
            "人物关系：先别说。",
        ] {
            assert!(!context_heading(body, false), "{body}");
        }
        let source = prepare_source("第一集\n场景：大厅\n故事简介中的人物走来。\n人物关系：先别说。\n苏远：他说【故事简介】没有更新。\n").unwrap();
        assert!(source.diagnostics.is_empty());
        assert!(source.rows[2..].iter().all(|r| r.kind == "body"));
    }

    #[test]
    fn unknown_prefix_stays_a_local_issue_without_inventing_an_episode() {
        let source =
            prepare_source("未注明用途的原文。\n第一集\n场景：门口\n小王：走。\n").unwrap();
        assert_eq!(source.episodes.len(), 1);
        assert!(source.rows[0].episode_id.is_none());
        assert_eq!(source.diagnostics.len(), 1);
        assert_eq!(
            source.diagnostics[0].row_ids,
            vec![source.rows[0].id.clone()]
        );
    }

    #[test]
    fn unversioned_legacy_sources_keep_their_original_contract_until_explicit_reparse() {
        let text = "【故事简介】\r\n资料文字😀。\r\n第一集\r\n场景：门口\r\n小王（低声）：别动（抬手），回来。\r\n";
        let legacy = parse_source(text, LEGACY_PARSER_VERSION).unwrap();
        let mut saved = serde_json::to_value(&legacy).unwrap();
        saved.as_object_mut().unwrap().remove("parserVersion");
        for row in saved["rows"].as_array_mut().unwrap() {
            if let Some(dialogue) = row["dialogue"].as_object_mut() {
                dialogue.remove("spokenSegments");
                dialogue.remove("performanceSegments");
            }
        }
        let saved: LockedSource = serde_json::from_value(saved).unwrap();
        assert_eq!(saved.parser_version, LEGACY_PARSER_VERSION);
        validate_source(&saved).unwrap();
        let upgraded = upgrade_source_dialogues(&saved).unwrap();
        assert_eq!(upgraded.parser_version, LEGACY_PARSER_VERSION);
        assert_eq!(upgraded.rows[0].kind, "body");
        assert!(!upgraded.rows[4]
            .dialogue
            .as_ref()
            .unwrap()
            .spoken_segments
            .is_empty());
        let recognized = reparse_source(&saved).unwrap();
        assert_eq!(recognized.parser_version, CURRENT_PARSER_VERSION);
        assert_eq!(recognized.rows[0].kind, "context");
        assert!(recognized.diagnostics.is_empty());
        assert_eq!(recognized.text, text);
        assert_eq!(recognized.sha256, saved.sha256);
        assert_eq!(recognized.rows[4].dialogue, upgraded.rows[4].dialogue);
        let unchanged = reparse_source(&recognized).unwrap();
        assert_eq!(
            serde_json::to_value(&recognized).unwrap(),
            serde_json::to_value(unchanged).unwrap()
        );
    }

    #[test]
    fn reparse_keeps_all_confirmed_boundary_decisions_and_exact_source_coordinates() {
        let legacy = parse_source(
            "【故事简介】\r\n资料。\r\n第一集\r\n小王：走😀。\r\n",
            LEGACY_PARSER_VERSION,
        )
        .unwrap();
        let decided = apply_boundary_decisions(
            &legacy,
            &[BoundaryDecision {
                start: legacy.rows[3].range.start,
                end: legacy.length,
                kind: "body".into(),
                episode_number: Some(1),
                scene_title: Some("已确认门口".into()),
                reason: "用户明确这一句属于门口场".into(),
            }],
        )
        .unwrap();
        let recognized = reparse_source(&decided).unwrap();
        assert_eq!(
            serde_json::to_value(&decided.boundary_decisions).unwrap(),
            serde_json::to_value(&recognized.boundary_decisions).unwrap()
        );
        assert_eq!(recognized.rows[3].scene_id, decided.rows[3].scene_id);
        assert_eq!(recognized.rows[3].dialogue, decided.rows[3].dialogue);
        assert_eq!(recognized.text, decided.text);
        assert_eq!(recognized.sha256, decided.sha256);
        assert_eq!(recognized.length, decided.length);
        assert!(recognized.diagnostics.is_empty());
        validate_source(&recognized).unwrap();
    }

    #[test]
    fn utf16_crlf_exact_coverage_and_quotes() {
        let text="作者资料\r\n姓名：张三\r\n第一集 重逢\r\n场景：门口\r\n张三（压低声音）OS：\"回来😀。\"\r\n李四：10:30到了。";
        let s = prepare_source(text).unwrap();
        assert_eq!(
            s.rows.iter().map(|r| r.text.as_str()).collect::<String>(),
            text
        );
        assert_eq!(s.length, text.encode_utf16().count());
        assert_eq!(s.episodes.len(), 1);
        assert_eq!(s.scenes.len(), 1);
        assert!(s.diagnostics.is_empty());
        let q = s.rows.iter().find_map(|r| r.dialogue.as_ref()).unwrap();
        assert_eq!(q.speaker, "张三");
        assert_eq!(q.channel, "OS");
        assert_eq!(q.quote, "\"回来😀。\"");
        assert!(slice_utf16("😀", &SourceRange { start: 0, end: 1 }).is_err());
    }
    #[test]
    fn unknown_boundaries_require_decision_without_changing_text() {
        let source = prepare_source("小王：走。\n△他推门。\n").unwrap();
        assert!(!source.diagnostics.is_empty());
        let ready = apply_boundary_decisions(
            &source,
            &[BoundaryDecision {
                start: 0,
                end: source.length,
                kind: "body".into(),
                episode_number: Some(1),
                scene_title: Some("门口".into()),
                reason: "用户明确此范围为第一集门口场".into(),
            }],
        )
        .unwrap();
        assert_eq!(ready.text, source.text);
        assert_eq!(ready.sha256, source.sha256);
        assert!(ready.diagnostics.is_empty());
        assert_eq!(ready.scenes.len(), 1);
    }
    #[test]
    fn altered_or_reordered_source_rejected() {
        let mut source = prepare_source("第一集\n场景：门口\n小王：走。\n").unwrap();
        source.rows.swap(1, 2);
        assert!(validate_source(&source).is_err());
    }
    #[test]
    fn source_classification_cannot_be_tampered_and_decision_keeps_existing_episode() {
        let mut s = prepare_source("第一集\n小王：走。\n").unwrap();
        let mut counterfeit = s.clone();
        counterfeit.rows[1].kind = "context".into();
        counterfeit.rows[1].dialogue = None;
        counterfeit.diagnostics.clear();
        assert!(validate_source(&counterfeit).is_err());
        s = apply_boundary_decisions(
            &s,
            &[BoundaryDecision {
                start: s.rows[1].range.start,
                end: s.length,
                kind: "body".into(),
                episode_number: Some(1),
                scene_title: Some("门口".into()),
                reason: "用户明确整集一场".into(),
            }],
        )
        .unwrap();
        assert_eq!(s.episodes.len(), 1);
        assert_eq!(s.episodes[0].number, 1);
        validate_source(&s).unwrap();
    }
    #[test]
    fn scene_mentions_scores_and_utc_colon_are_body() {
        let s = prepare_source("第一集\n场景：大厅\n小王：场景：门口，我们10:30走。\n10-20 分\n")
            .unwrap();
        assert_eq!(s.scenes.len(), 1);
        assert_eq!(s.rows[2].kind, "body");
        assert_eq!(s.rows[3].kind, "body");
    }
    #[test]
    fn numbered_labels_post_channel_hints_and_parenthetical_colons() {
        let s=prepare_source("第一集\n场景：大厅\n1号工人 VO（语气：轻快）：到齐了。\n10:30\n小王（内心：急切）OS：快些。\n").unwrap();
        let q = s.rows[2].dialogue.as_ref().unwrap();
        assert_eq!(q.speaker, "1号工人");
        assert_eq!(q.channel, "VO");
        assert_eq!(q.quote, "到齐了。");
        assert!(s.rows[3].dialogue.is_none());
        assert_eq!(s.rows[4].dialogue.as_ref().unwrap().channel, "OS");
    }
    #[test]
    fn explicit_bare_and_combined_scene_headers_without_rewriting() {
        let text = "第一集 场1-1 日 内 大厅\r\n小王：到了。\r\n1-2\r\n夜 外 门口\r\n小王：走。\r\n";
        let s = prepare_source(text).unwrap();
        assert!(s.diagnostics.is_empty());
        assert_eq!(s.scenes.len(), 2);
        assert_eq!(s.rows[3].kind, "format");
        assert_eq!(
            s.rows.iter().map(|r| r.text.as_str()).collect::<String>(),
            text
        );
    }
}
