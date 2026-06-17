const fs = require('fs');

function parseJSX(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  
  // We want to remove string literals first to avoid matching false tags
  // Replace double quoted strings, single quoted strings, template literals
  let clean = content;
  
  // Strip multi-line comments /* ... */ and JSX comments {/* ... */}
  clean = clean.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, ' ');
  clean = clean.replace(/\/\*[\s\S]*?\*\//g, ' ');
  // Strip single-line comments
  clean = clean.replace(/\/\/.*/g, ' ');
  
  // Strip string literals
  clean = clean.replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '""');
  clean = clean.replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, "''");
  clean = clean.replace(/`[^`\\]*(?:\\.[^`\\]*)*`/g, "``");
  
  const lines = clean.split('\n');
  const stack = [];
  
  for (let idx = 0; idx < lines.length; idx++) {
    const lineNum = idx + 1;
    const line = lines[idx];
    
    // We want to find tags
    // Match <tagName ...> or </tagName>
    // Be careful with comparisons like < or >
    // Let's use a regex that matches:
    // 1. </tagName>
    // 2. <tagName ... /> (self-closing)
    // 3. <tagName ... > (opening)
    // Avoid matching JS comparison operators like `i < prices.length` or `a < b`
    
    // Let's find matches
    let pos = 0;
    while (true) {
      const match = line.indexOf('<', pos);
      if (match === -1) break;
      
      pos = match + 1;
      
      // Check if it looks like a tag
      // It must be followed by a letter, a slash, or a fragment start <>
      const nextChar = line[match + 1];
      if (!nextChar) continue;
      
      if (nextChar === '>') {
        // Fragment opening <>
        stack.push({ tag: 'Fragment', line: lineNum });
        pos = match + 2;
        continue;
      }
      
      if (nextChar === '/') {
        // Closing tag </
        const endClose = line.indexOf('>', match + 2);
        if (endClose === -1) continue;
        const tagName = line.slice(match + 2, endClose).trim().split(/\s+/)[0];
        if (tagName === '') {
          // Fragment closing </>
          const popped = stack.pop();
          if (!popped) {
            console.log(`Line ${lineNum}: Closing fragment </> with empty stack`);
          } else if (popped.tag !== 'Fragment') {
            console.log(`Line ${lineNum}: Mismatch! Closing </> does not match open <${popped.tag}> from line ${popped.line}`);
            stack.push(popped);
          }
        } else {
          const popped = stack.pop();
          if (!popped) {
            console.log(`Line ${lineNum}: Closing tag </${tagName}> with empty stack`);
          } else if (popped.tag !== tagName) {
            console.log(`Line ${lineNum}: Mismatch! Closing </${tagName}> does not match open <${popped.tag}> from line ${popped.line}`);
            stack.push(popped); // put it back
          }
        }
        pos = endClose + 1;
        continue;
      }
      
      // Must start with letter or capital letter for component
      if (!/[a-zA-Z]/.test(nextChar)) {
        continue;
      }
      
      // It's a potential opening tag. Let's find its matching '>' on the same line or subsequent lines
      // For simplicity, let's find the closing '>' of this tag.
      // But wait! There could be nested expressions with '>' inside the tag attributes, e.g. style={{...}}
      // Let's do a brace-aware search for '>'
      let tagEnd = -1;
      let braceCount = 0;
      let quoteChar = null;
      
      let curLineIdx = idx;
      let curColIdx = match + 1;
      
      outer: while (curLineIdx < lines.length) {
        const curLine = lines[curLineIdx];
        while (curColIdx < curLine.length) {
          const char = curLine[curColIdx];
          
          if (quoteChar) {
            if (char === quoteChar) {
              quoteChar = null;
            }
          } else if (char === '"' || char === "'") {
            quoteChar = char;
          } else if (char === '{') {
            braceCount++;
          } else if (char === '}') {
            braceCount--;
          } else if (char === '>' && braceCount === 0) {
            tagEnd = curColIdx;
            break outer;
          }
          curColIdx++;
        }
        curLineIdx++;
        curColIdx = 0;
      }
      
      if (tagEnd === -1) {
        // Tag doesn't end properly or is not a tag
        continue;
      }
      
      // Extract tag content
      let tagContent = '';
      if (curLineIdx === idx) {
        tagContent = line.slice(match + 1, tagEnd);
      } else {
        tagContent = line.slice(match + 1) + ' ' + lines.slice(idx + 1, curLineIdx).join(' ') + ' ' + lines[curLineIdx].slice(0, tagEnd);
      }
      
      tagContent = tagContent.trim();
      const tagName = tagContent.split(/\s+/)[0];
      
      // Check if self-closing
      const isSelfClosing = tagContent.endsWith('/') || 
                            ['input', 'img', 'br', 'hr', 'link', 'meta'].includes(tagName.toLowerCase()) ||
                            tagName.startsWith('Icon'); // Assumption that icons are self closing if not specified otherwise
                            
      if (!isSelfClosing) {
        stack.push({ tag: tagName, line: lineNum });
      }
      
      // Update pos to continue scanning
      if (curLineIdx === idx) {
        pos = tagEnd + 1;
      } else {
        // We moved to another line, so break scanning this line and let the loop proceed
        idx = curLineIdx;
        pos = tagEnd + 1;
        break;
      }
    }
  }
  
  console.log("\n--- Unclosed tags left in stack ---");
  stack.forEach(item => {
    console.log(`<${item.tag}> opened on line ${item.line} is never closed`);
  });
}

parseJSX('components/MarketStructureView.tsx');
