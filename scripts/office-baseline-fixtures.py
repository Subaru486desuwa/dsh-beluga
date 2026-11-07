"""Build synthetic OOXML fixtures. Use the dedicated office-baseline venv."""
import json
from pathlib import Path
from zipfile import ZipFile
from docx import Document
from docx.shared import Pt
from pptx import Presentation
from pptx.util import Inches, Pt as SlidePt
from openpyxl import Workbook, load_workbook
from openpyxl.chart import BarChart, Reference
from openpyxl.styles import Font, PatternFill

OUT = Path(__file__).resolve().parents[1] / '.artifacts/office-baseline/fixtures'
OUT.mkdir(parents=True, exist_ok=True)
for name in ['office-report.pdf', 'office-budget.pdf', 'office-brief.pdf']:
 (OUT/name).unlink(missing_ok=True)
rows = [('R&D', 100000, 120000), ('Marketing', 80000, 60000), ('Operations', 50000, 55000)]
word = Document()
word.styles['Normal'].font.name = 'Noto Sans CJK SC'
word.styles['Normal'].font.size = Pt(11)
word.add_heading('Q1 办公验收报告 / Office baseline', 0)
word.add_heading('一、目标与事实', level=1)
word.add_paragraph('WORD_CANARY_20261106：保留中文段落、层级标题与表格；原始材料不可覆盖。')
table = word.add_table(rows=1, cols=3); table.style = 'Table Grid'
for cell, value in zip(table.rows[0].cells, ['部门', '预算 / 元', '实际 / 元']): cell.text = value
for row in rows:
 for cell, value in zip(table.add_row().cells, row): cell.text = str(value)
word.add_heading('二、审阅要求', level=1)
word.add_paragraph('预算合计 230,000 元；实际 235,000 元；超支 5,000 元。只修改指定段落，保留表格与页眉。')
word.sections[0].header.paragraphs[0].text = 'Synthetic acceptance material — not real business data'
word.save(OUT/'office-report.docx')
assert 'WORD_CANARY_20261106' in '\n'.join(p.text for p in Document(OUT/'office-report.docx').paragraphs)

book = Workbook(); sheet = book.active; sheet.title = 'Actuals'
sheet.append(['Department', 'Budget', 'Actual', 'Variance', 'VariancePct'])
for i, row in enumerate(rows, start=2): sheet.append([*row, f'=C{i}-B{i}', f'=D{i}/B{i}'])
sheet.append(['Total', '=SUM(B2:B4)', '=SUM(C2:C4)', '=C5-B5', '=D5/B5'])
for cell in sheet[1]: cell.font = Font(bold=True); cell.fill = PatternFill('solid', fgColor='DCE6F1')
for column in ['A','B','C','D','E']: sheet.column_dimensions[column].width = 20
for row in sheet.iter_rows(min_row=2, min_col=2, max_col=4):
 for cell in row: cell.number_format = '#,##0.00'
for row in sheet.iter_rows(min_row=2, min_col=5, max_col=5): row[0].number_format = '0.00%'
sheet.freeze_panes = 'A2'
assumptions = book.create_sheet('Assumptions')
assumptions['A1'] = 'XLSX_CANARY_20261106'
assumptions['A2'] = 'Currency=CNY; positive expense variance=unfavorable'
chart = BarChart(); chart.title = 'Budget vs. Actual'; chart.add_data(Reference(sheet, min_col=2, max_col=3, min_row=1, max_row=4), titles_from_data=True); chart.set_categories(Reference(sheet, min_col=1, min_row=2, max_row=4)); sheet.add_chart(chart, 'A8')
book.save(OUT/'office-budget.xlsx')
readback = load_workbook(OUT/'office-budget.xlsx', data_only=False)
assert readback['Actuals']['D5'].value == '=C5-B5'
assert readback['Actuals']['B5'].value == '=SUM(B2:B4)'
assert len(readback['Actuals']._charts) == 1

slides = Presentation(); slides.slide_width = Inches(13.333); slides.slide_height = Inches(7.5)
for title, content in [('Q1 预算复盘', 'PPTX_CANARY_20261106\n预算 230,000 元；实际 235,000 元\n超支 5,000 元，偏差约 2.17%'), ('下一步 / Next steps', '保留原主题与版式\n只修改指定页面\n核对图表数字与 Excel 一致')]:
 slide = slides.slides.add_slide(slides.slide_layouts[6])
 for y, height, text, size in [(0.5, 1.1, title, 32), (2.0, 4.2, content, 24)]:
  box = slide.shapes.add_textbox(Inches(0.8), Inches(y), Inches(11.7), Inches(height))
  box.text_frame.word_wrap = True
  for i, line in enumerate(text.split('\n')):
   paragraph = box.text_frame.paragraphs[0] if i == 0 else box.text_frame.add_paragraph()
   paragraph.text = line; paragraph.font.size = SlidePt(size); paragraph.font.name = 'Noto Sans CJK SC'
 slide.notes_slide.notes_text_frame.text = 'Synthetic fixture; preserve slide objects as editable shapes.'
slides.save(OUT/'office-brief.pptx')
assert len(Presentation(OUT/'office-brief.pptx').slides) == 2
for name in ['office-report.docx','office-budget.xlsx','office-brief.pptx']:
 with ZipFile(OUT/name) as archive:
  assert '[Content_Types].xml' in archive.namelist() and archive.testzip() is None
(OUT/'office-budget.csv').write_text('Department,Budget,Actual\nR&D,100000,120000\nMarketing,80000,60000\nOperations,50000,55000\n', encoding='utf-8')
(OUT/'office-notes.txt').write_text('TEXT_CANARY_20261106; total budget=230000; total actual=235000; variance=5000.', encoding='utf-8')
(OUT/'manifest.json').write_text(json.dumps({'synthetic': True, 'expected': {'word': 'WORD_CANARY_20261106', 'pptx': 'PPTX_CANARY_20261106', 'xlsx': 'XLSX_CANARY_20261106', 'totalBudget': 230000, 'totalActual': 235000, 'variance': 5000}, 'files': sorted(p.name for p in OUT.iterdir() if p.suffix != '.json')}, indent=2) + '\n')
print(json.dumps({'output': str(OUT), 'files': [{'name': p.name, 'bytes': p.stat().st_size} for p in sorted(OUT.iterdir())]}, indent=2))
