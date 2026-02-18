/**
 * Ghostwriter Book Creation Script
 *
 * Creates professionally formatted book documents with proper structure,
 * typography, and print-ready layout specifications.
 *
 * Usage: node create-book.js <config.json> <output.docx>
 *
 * Config JSON structure:
 * {
 *   "title": "Book Title",
 *   "subtitle": "Optional Subtitle",
 *   "author": "Author Name",
 *   "dedication": "Optional dedication text",
 *   "copyright": {
 *     "year": 2025,
 *     "holder": "Author Name",
 *     "isbn": "978-0-000-00000-0"
 *   },
 *   "chapters": [
 *     {
 *       "type": "preface", // or "chapter", "conclusion", "about"
 *       "title": "Prefácio",
 *       "content": ["Paragraph 1", "Paragraph 2", ...]
 *     },
 *     {
 *       "type": "chapter",
 *       "number": 1,
 *       "title": "Chapter Title",
 *       "subtitle": "Optional chapter subtitle",
 *       "content": ["Paragraph 1", "Paragraph 2", ...]
 *     }
 *   ]
 * }
 */

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  PageBreak,
  Header,
  Footer,
  AlignmentType,
  PageNumber,
  TableOfContents,
  HeadingLevel,
  TabStopType,
  TabStopPosition,
  convertInchesToTwip
} = require('docx');
const fs = require('fs');

// Page dimensions in twips (1 inch = 1440 twips)
const PAGE = {
  WIDTH: 8640,    // 6 inches
  HEIGHT: 12960,  // 9 inches
  MARGIN_TOP: 1512,     // 1.05 inches
  MARGIN_BOTTOM: 864,   // 0.60 inches
  MARGIN_LEFT: 864,     // 0.60 inches (outside)
  MARGIN_RIGHT: 1008,   // 0.70 inches (outside)
  MARGIN_GUTTER: 576    // 0.40 inches
};

// Typography sizes (in half-points, so 14pt = 28)
const FONT = {
  BODY: 28,           // 14pt
  TITLE: 72,          // 36pt
  SUBTITLE: 40,       // 20pt
  CHAPTER_TITLE: 52,  // 26pt
  SUBHEADING: 28,     // 14pt (bold)
  PAGE_NUMBER: 20,    // 10pt
  COPYRIGHT: 22       // 11pt
};

const FONT_FAMILY = "Garamond";

// Spacing in twips
const SPACING = {
  PARAGRAPH_BEFORE: 120,
  PARAGRAPH_AFTER: 240,
  CHAPTER_BEFORE: 480,
  CHAPTER_AFTER: 480,
  FIRST_LINE_INDENT: 720  // 0.5 inches
};

/**
 * Create a body paragraph with proper formatting
 */
function createBodyParagraph(text, isFirstInSection = false) {
  return new Paragraph({
    alignment: AlignmentType.BOTH,
    spacing: {
      before: SPACING.PARAGRAPH_BEFORE,
      after: SPACING.PARAGRAPH_AFTER,
      line: 240,
      lineRule: "auto"
    },
    indent: isFirstInSection ? {} : { firstLine: SPACING.FIRST_LINE_INDENT },
    children: [
      new TextRun({
        text: text,
        font: FONT_FAMILY,
        size: FONT.BODY
      })
    ]
  });
}

/**
 * Create italic paragraph (for quotes, emphasis)
 */
function createItalicParagraph(text, isFirstInSection = false) {
  return new Paragraph({
    alignment: AlignmentType.BOTH,
    spacing: {
      before: SPACING.PARAGRAPH_BEFORE,
      after: SPACING.PARAGRAPH_AFTER,
      line: 240,
      lineRule: "auto"
    },
    indent: isFirstInSection ? {} : { firstLine: SPACING.FIRST_LINE_INDENT },
    children: [
      new TextRun({
        text: text,
        font: FONT_FAMILY,
        size: FONT.BODY,
        italics: true
      })
    ]
  });
}

/**
 * Create bold paragraph (for emphasis)
 */
function createBoldParagraph(text, centered = false) {
  return new Paragraph({
    alignment: centered ? AlignmentType.CENTER : AlignmentType.BOTH,
    spacing: {
      before: SPACING.PARAGRAPH_BEFORE,
      after: SPACING.PARAGRAPH_AFTER,
      line: 240,
      lineRule: "auto"
    },
    children: [
      new TextRun({
        text: text,
        font: FONT_FAMILY,
        size: FONT.BODY,
        bold: true
      })
    ]
  });
}

/**
 * Create title page
 */
function createTitlePage(config) {
  const elements = [];

  // Spacing before title
  for (let i = 0; i < 8; i++) {
    elements.push(new Paragraph({ children: [] }));
  }

  // Main title
  elements.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [
      new TextRun({
        text: config.title.toUpperCase(),
        font: FONT_FAMILY,
        size: FONT.TITLE,
        bold: true
      })
    ]
  }));

  // Subtitle if present
  if (config.subtitle) {
    elements.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 200 },
      children: [
        new TextRun({
          text: config.subtitle,
          font: FONT_FAMILY,
          size: FONT.SUBTITLE,
          italics: true
        })
      ]
    }));
  }

  // Spacing before author
  for (let i = 0; i < 10; i++) {
    elements.push(new Paragraph({ children: [] }));
  }

  // Author name
  elements.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [
      new TextRun({
        text: config.author,
        font: FONT_FAMILY,
        size: FONT.BODY,
        bold: true
      })
    ]
  }));

  // Page break
  elements.push(new Paragraph({ children: [new PageBreak()] }));

  return elements;
}

/**
 * Create copyright page
 */
function createCopyrightPage(config) {
  const elements = [];
  const copyright = config.copyright || {};
  const year = copyright.year || new Date().getFullYear();
  const holder = copyright.holder || config.author;

  // Blank page (verso of title)
  elements.push(new Paragraph({ children: [new PageBreak()] }));

  // Copyright content
  elements.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 400 },
    children: [
      new TextRun({
        text: `Copyright © ${year} ${holder}`,
        font: FONT_FAMILY,
        size: FONT.COPYRIGHT
      })
    ]
  }));

  elements.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 200 },
    children: [
      new TextRun({
        text: "Todos os direitos reservados",
        font: FONT_FAMILY,
        size: FONT.COPYRIGHT
      })
    ]
  }));

  if (copyright.isbn) {
    elements.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
      children: [
        new TextRun({
          text: `ISBN: ${copyright.isbn}`,
          font: FONT_FAMILY,
          size: FONT.COPYRIGHT
        })
      ]
    }));
  }

  elements.push(new Paragraph({
    alignment: AlignmentType.BOTH,
    spacing: { after: 200 },
    children: [
      new TextRun({
        text: "Nenhuma parte desta publicação pode ser reproduzida, armazenada em sistema de recuperação ou transmitida de qualquer forma ou por qualquer meio, eletrônico, mecânico, fotocópia, gravação ou outro, sem a permissão prévia por escrito do autor.",
        font: FONT_FAMILY,
        size: FONT.COPYRIGHT
      })
    ]
  }));

  elements.push(new Paragraph({ children: [new PageBreak()] }));

  return elements;
}

/**
 * Create dedication page
 */
function createDedicationPage(config) {
  if (!config.dedication) return [];

  const elements = [];

  elements.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 400, after: 400 },
    children: [
      new TextRun({
        text: "DEDICATÓRIA",
        font: FONT_FAMILY,
        size: FONT.BODY,
        bold: true
      })
    ]
  }));

  elements.push(new Paragraph({ children: [] }));

  // Split dedication into paragraphs if it contains newlines
  const paragraphs = config.dedication.split('\n').filter(p => p.trim());
  paragraphs.forEach((para, index) => {
    elements.push(new Paragraph({
      alignment: AlignmentType.BOTH,
      spacing: { after: 200 },
      children: [
        new TextRun({
          text: para.trim(),
          font: FONT_FAMILY,
          size: FONT.BODY
        })
      ]
    }));
  });

  elements.push(new Paragraph({ children: [new PageBreak()] }));

  return elements;
}

/**
 * Create table of contents placeholder
 */
function createTableOfContents(config) {
  const elements = [];

  elements.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    heading: HeadingLevel.HEADING_1,
    spacing: { after: 400 },
    children: [
      new TextRun({
        text: "SUMÁRIO",
        font: FONT_FAMILY,
        size: FONT.TITLE,
        bold: true
      })
    ]
  }));

  elements.push(new Paragraph({ children: [] }));

  // Generate TOC entries based on chapters
  if (config.chapters) {
    config.chapters.forEach((chapter, index) => {
      let tocText = "";

      if (chapter.type === "preface" || chapter.type === "prefacio") {
        tocText = "Prefácio";
      } else if (chapter.type === "conclusion" || chapter.type === "conclusao") {
        tocText = "Conclusão";
      } else if (chapter.type === "about") {
        tocText = "Sobre o Autor";
      } else if (chapter.type === "chapter" || chapter.type === "capitulo") {
        tocText = `Capítulo ${chapter.number || index} - ${chapter.title}`;
      } else if (chapter.type === "part" || chapter.type === "parte") {
        tocText = `PARTE ${chapter.number || index}: ${chapter.title}`;
      } else {
        tocText = chapter.title || `Capítulo ${index + 1}`;
      }

      elements.push(new Paragraph({
        tabStops: [
          { type: TabStopType.RIGHT, position: TabStopPosition.MAX, leader: "dot" }
        ],
        spacing: { after: 120 },
        children: [
          new TextRun({
            text: tocText + "\t",
            font: FONT_FAMILY,
            size: FONT.BODY
          }),
          new TextRun({
            text: "##", // Placeholder for page number
            font: FONT_FAMILY,
            size: FONT.BODY
          })
        ]
      }));
    });
  }

  elements.push(new Paragraph({ children: [new PageBreak()] }));

  return elements;
}

/**
 * Create chapter heading
 */
function createChapterHeading(chapter, chapterIndex) {
  const elements = [];

  if (chapter.type === "part" || chapter.type === "parte") {
    // Part title - full page centered
    for (let i = 0; i < 8; i++) {
      elements.push(new Paragraph({ children: [] }));
    }

    elements.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      heading: HeadingLevel.HEADING_1,
      children: [
        new TextRun({
          text: `PARTE ${chapter.number || chapterIndex}`,
          font: FONT_FAMILY,
          size: FONT.TITLE,
          bold: true
        })
      ]
    }));

    if (chapter.title) {
      elements.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 200 },
        children: [
          new TextRun({
            text: chapter.title,
            font: FONT_FAMILY,
            size: FONT.SUBTITLE,
            italics: true
          })
        ]
      }));
    }

    elements.push(new Paragraph({ children: [new PageBreak()] }));
  } else {
    // Regular chapter heading
    let headingText = "";

    if (chapter.type === "preface" || chapter.type === "prefacio") {
      headingText = "PREFÁCIO";
    } else if (chapter.type === "conclusion" || chapter.type === "conclusao") {
      headingText = "CONCLUSÃO";
    } else if (chapter.type === "about") {
      headingText = "SOBRE O AUTOR";
    } else {
      headingText = `CAPÍTULO ${chapter.number || chapterIndex}`;
    }

    elements.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      heading: HeadingLevel.HEADING_1,
      spacing: { before: SPACING.CHAPTER_BEFORE, after: 200 },
      children: [
        new TextRun({
          text: headingText,
          font: FONT_FAMILY,
          size: FONT.TITLE,
          bold: true
        })
      ]
    }));

    if (chapter.title && chapter.type !== "preface" && chapter.type !== "prefacio") {
      elements.push(new Paragraph({
        alignment: AlignmentType.LEFT,
        heading: HeadingLevel.HEADING_2,
        spacing: { after: SPACING.CHAPTER_AFTER },
        children: [
          new TextRun({
            text: chapter.title,
            font: FONT_FAMILY,
            size: FONT.CHAPTER_TITLE
          })
        ]
      }));
    }

    if (chapter.subtitle) {
      elements.push(new Paragraph({
        alignment: AlignmentType.LEFT,
        spacing: { after: SPACING.CHAPTER_AFTER },
        children: [
          new TextRun({
            text: chapter.subtitle,
            font: FONT_FAMILY,
            size: FONT.BODY,
            italics: true
          })
        ]
      }));
    }
  }

  return elements;
}

/**
 * Process chapter content - handles special formatting markers
 */
function processChapterContent(content) {
  const elements = [];

  if (!content || !Array.isArray(content)) return elements;

  content.forEach((para, index) => {
    const isFirst = index === 0;

    // Check for special formatting markers
    if (para.startsWith('***') && para.endsWith('***')) {
      // Bold italic (biblical quotes, important quotes)
      elements.push(createItalicParagraph(para.slice(3, -3), isFirst));
    } else if (para.startsWith('**') && para.endsWith('**')) {
      // Bold text
      elements.push(createBoldParagraph(para.slice(2, -2), false));
    } else if (para.startsWith('*') && para.endsWith('*')) {
      // Italic text
      elements.push(createItalicParagraph(para.slice(1, -1), isFirst));
    } else if (para.startsWith('##')) {
      // Subheading
      elements.push(new Paragraph({
        alignment: AlignmentType.LEFT,
        spacing: { before: 400, after: 200 },
        children: [
          new TextRun({
            text: para.slice(2).trim(),
            font: FONT_FAMILY,
            size: FONT.SUBHEADING,
            bold: true
          })
        ]
      }));
    } else if (para.startsWith('> ')) {
      // Block quote
      elements.push(new Paragraph({
        alignment: AlignmentType.BOTH,
        spacing: { before: 200, after: 200 },
        indent: { left: 720, right: 720 },
        children: [
          new TextRun({
            text: para.slice(2),
            font: FONT_FAMILY,
            size: FONT.BODY,
            italics: true
          })
        ]
      }));
    } else if (para === '---') {
      // Scene break / separator
      elements.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 400, after: 400 },
        children: [
          new TextRun({
            text: "* * *",
            font: FONT_FAMILY,
            size: FONT.BODY
          })
        ]
      }));
    } else if (para.trim() === '') {
      // Empty paragraph for spacing
      elements.push(new Paragraph({ children: [] }));
    } else {
      // Regular paragraph
      elements.push(createBodyParagraph(para, isFirst));
    }
  });

  return elements;
}

/**
 * Create full chapter
 */
function createChapter(chapter, chapterIndex) {
  const elements = [];

  // Chapter heading
  elements.push(...createChapterHeading(chapter, chapterIndex));

  // Chapter content
  if (chapter.content) {
    elements.push(...processChapterContent(chapter.content));
  }

  // Page break after chapter (except for parts)
  if (chapter.type !== "part" && chapter.type !== "parte") {
    elements.push(new Paragraph({ children: [new PageBreak()] }));
  }

  return elements;
}

/**
 * Create the complete book document
 */
function createBook(config) {
  const children = [];

  // Front matter
  children.push(...createTitlePage(config));
  children.push(...createCopyrightPage(config));
  children.push(...createDedicationPage(config));
  children.push(...createTableOfContents(config));

  // Body - chapters
  if (config.chapters) {
    let chapterNum = 1;
    config.chapters.forEach((chapter, index) => {
      if (chapter.type === "chapter" || chapter.type === "capitulo") {
        chapter.number = chapter.number || chapterNum;
        chapterNum++;
      }
      children.push(...createChapter(chapter, index + 1));
    });
  }

  // Create document
  const doc = new Document({
    styles: {
      default: {
        document: {
          run: {
            font: FONT_FAMILY,
            size: FONT.BODY
          }
        }
      },
      paragraphStyles: [
        {
          id: "Normal",
          name: "Normal",
          run: { font: FONT_FAMILY, size: FONT.BODY },
          paragraph: {
            spacing: {
              before: SPACING.PARAGRAPH_BEFORE,
              after: SPACING.PARAGRAPH_AFTER,
              line: 240,
              lineRule: "auto"
            },
            alignment: AlignmentType.BOTH
          }
        },
        {
          id: "Heading1",
          name: "Heading 1",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { font: FONT_FAMILY, size: FONT.TITLE, bold: true },
          paragraph: {
            spacing: { before: 240, after: 240 },
            alignment: AlignmentType.CENTER,
            outlineLevel: 0
          }
        },
        {
          id: "Heading2",
          name: "Heading 2",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { font: FONT_FAMILY, size: FONT.CHAPTER_TITLE },
          paragraph: {
            spacing: { before: 200, after: 200 },
            alignment: AlignmentType.LEFT,
            outlineLevel: 1
          }
        }
      ]
    },
    sections: [{
      properties: {
        page: {
          size: {
            width: PAGE.WIDTH,
            height: PAGE.HEIGHT
          },
          margin: {
            top: PAGE.MARGIN_TOP,
            bottom: PAGE.MARGIN_BOTTOM,
            left: PAGE.MARGIN_LEFT,
            right: PAGE.MARGIN_RIGHT,
            gutter: PAGE.MARGIN_GUTTER
          }
        }
      },
      footers: {
        default: new Footer({
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({
                  children: [PageNumber.CURRENT],
                  font: FONT_FAMILY,
                  size: FONT.PAGE_NUMBER
                })
              ]
            })
          ]
        })
      },
      children: children
    }]
  });

  return doc;
}

/**
 * Main execution
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log("Usage: node create-book.js <config.json> <output.docx>");
    console.log("");
    console.log("Config JSON should contain:");
    console.log("  - title: Book title");
    console.log("  - subtitle: Optional subtitle");
    console.log("  - author: Author name");
    console.log("  - dedication: Optional dedication text");
    console.log("  - copyright: { year, holder, isbn }");
    console.log("  - chapters: Array of chapter objects");
    process.exit(1);
  }

  const configPath = args[0];
  const outputPath = args[1];

  // Read config
  const configData = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(configData);

  // Create document
  const doc = createBook(config);

  // Save to file
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);

  console.log(`Book created successfully: ${outputPath}`);
  console.log(`  Title: ${config.title}`);
  console.log(`  Author: ${config.author}`);
  console.log(`  Chapters: ${config.chapters ? config.chapters.length : 0}`);
}

// Export for use as module
module.exports = { createBook, createBodyParagraph, createChapter };

// Run if called directly
if (require.main === module) {
  main().catch(err => {
    console.error("Error creating book:", err);
    process.exit(1);
  });
}
