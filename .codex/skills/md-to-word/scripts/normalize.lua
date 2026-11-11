-- Parse embedded HTML instead of letting the DOCX writer silently discard it.
function RawBlock(el)
  if el.format == 'html' then
    if el.text:match('^%s*<!%-%-') then return {} end
    local doc = pandoc.read(el.text, 'html')
    if #doc.blocks == 0 then error('Unsupported HTML block: ' .. el.text:sub(1,100)) end
    return doc.blocks
  end
  error('Unsupported raw block: ' .. el.format)
end

function RawInline(el)
  if el.format == 'html' and el.text:lower():match('^<br%s*/?>$') then
    return pandoc.LineBreak()
  end
  error('Unsupported inline markup: ' .. el.text)
end

function Pandoc(doc)
  -- A single leading H1 is the document title; multiple H1s stay as headings.
  local count = 0
  for _, b in ipairs(doc.blocks) do
    if b.t == 'Header' and b.level == 1 then count = count + 1 end
  end
  if count == 1 and doc.blocks[1] and doc.blocks[1].t == 'Header' and doc.blocks[1].level == 1 then
    doc.meta.title = pandoc.MetaInlines(doc.blocks[1].content)
    doc.blocks:remove(1)
    doc = doc:walk({Header = function(h) h.level = math.max(1,h.level-1); return h end})
  end
  return doc
end
