import re

def find_mismatch(filename):
    with open(filename, 'r') as f:
        content = f.read()

    # Simple tag parser for <div> / </div> and other tags
    # We strip comments
    content = re.sub(r'{\s*/\*.*?\*/\s*}', '', content, flags=re.DOTALL)
    content = re.sub(r'<!--.*?-->', '', content, flags=re.DOTALL)

    # Let's find tags in the return block starting from line 465 (approx)
    lines = content.split('\n')
    
    stack = []
    
    # We want to scan the JSX lines
    for line_idx, line in enumerate(lines):
        line_num = line_idx + 1
        if line_num < 465:
            continue
            
        # Find all tags on this line
        # Regex to find <tag ...> or </tag>
        # We need to ignore self-closing tags like <img />, <input />, <hr />, <br />, <Icon... /> etc.
        # And ignore string constants or templates
        
        # We can find potential tags
        tags = re.findall(r'<(/?[a-zA-Z0-9_\.\-]+)(?:\s+[^>]*?)?(/?)(?<!=)>', line)
        for tag, self_close in tags:
            # Check if self closing (ends with /)
            if self_close == '/' or tag.lower() in ['input', 'img', 'br', 'hr', 'link', 'meta']:
                continue
                
            if tag.startswith('/'):
                close_tag = tag[1:]
                if not stack:
                    print(f"Line {line_num}: Closing tag </{close_tag}> found with empty stack")
                else:
                    open_tag, open_line = stack.pop()
                    if open_tag != close_tag:
                        print(f"Line {line_num}: Mismatch! Closing </{close_tag}> does not match open <{open_tag}> from Line {open_line}")
                        # Restore stack to continue
                        stack.append((open_tag, open_line))
            else:
                stack.append((tag, line_num))
                
    print("\n--- Remaining unclosed tags in stack ---")
    for tag, line in stack:
        print(f"<{tag}> opened on Line {line} is never closed")

if __name__ == '__main__':
    find_mismatch('components/MarketStructureView.tsx')
