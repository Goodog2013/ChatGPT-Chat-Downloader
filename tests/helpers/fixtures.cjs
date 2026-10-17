const { deflateRawSync } = require("node:zlib");

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}

// Independent ZIP32 fixture writer: retains intentionally unsafe/duplicate
// names so rejection tests do not get pre-filtered by the production writer.
function makeZip(entries, { compressed = true } = {}) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const filename = Buffer.from(name), bytes = Buffer.from(typeof content === "string" ? content : JSON.stringify(content));
    const data = compressed ? deflateRawSync(bytes) : bytes;
    const header = Buffer.alloc(30), record = Buffer.alloc(46), crc = crc32(bytes);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6); header.writeUInt16LE(compressed ? 8 : 0, 8);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4);
    header.copy(record, 6, 4, 30); record.writeUInt32LE(offset, 42);
    local.push(header, filename, data); central.push(record, filename);
    offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function conversation(id, title = id, time = 1700000000) {
  const texts = [
    `Synthetic user ${id}: Привет 🧪 "quoted" \\path\nSecond line.`,
    `Synthetic assistant ${id}:\n\n\`\`\`js\nconst value = { count: 2 };\n\`\`\``,
    `Synthetic follow-up ${id}: keep [brackets], {braces} and <tags>.`,
    `Synthetic final ${id}: messages stay in their original order.`,
  ];
  const mapping = { root: { id: "root", parent: null, children: [`${id}-m0`], message: null } };
  texts.forEach((text, index) => {
    const nodeId = `${id}-m${index}`;
    mapping[nodeId] = { id: nodeId, parent: index ? `${id}-m${index - 1}` : "root",
      children: index < texts.length - 1 ? [`${id}-m${index + 1}`] : [],
      message: { id: nodeId, author: { role: index % 2 ? "assistant" : "user" },
        create_time: time + index, status: "finished_successfully", content: { content_type: "text", parts: [text] } } };
  });
  const altId = `${id}-alternate`;
  mapping[`${id}-m0`].children.push(altId);
  mapping[altId] = { id: altId, parent: `${id}-m0`, children: [], message: {
    id: altId, author: { role: "assistant" }, create_time: time + 1,
    content: { content_type: "text", parts: [`Synthetic alternate ${id}: also retained.`] },
  } };
  return { id, title, current_node: `${id}-m3`, create_time: time, update_time: time + 3, mapping };
}

function multipartEntries(prefix = "") {
  // ZIP entry order deliberately differs from both numeric and lexical order.
  return [11, 2, 10, 1].map(part => [`${prefix}conversations-${part}.json`,
    ["B", "A"].map(suffix => conversation(`part-${part}-${suffix}`, `Synthetic part ${part} / ${suffix}`))]);
}

function expectedMessages(chat) {
  return [0, 1, 2, 3].map(index => {
    const message = chat.mapping[`${chat.id}-m${index}`].message;
    return { id: message.id, parentId: index ? `${chat.id}-m${index - 1}` : null,
      role: message.author.role, text: message.content.parts[0], createdAt: new Date(message.create_time * 1000).toISOString() };
  });
}

module.exports = { makeZip, conversation, multipartEntries, expectedMessages };
