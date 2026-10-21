"""Genera web/ (página autónoma para Vercel) a partir de index.html (fuente del artifact).

El artifact recibe el esqueleto <html><head><body> al publicarse; aquí se añade a mano,
con noindex mientras sea un modelo. Uso: python3 landing/build_web.py
"""
import os, re, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "web")
src = open(os.path.join(HERE, "index.html"), encoding="utf-8").read()

head_end = src.index("</style>") + len("</style>")
head, body = src[:head_end], src[head_end:]
head = re.sub(r'<meta name="claude:[^>]*>\n', "", head)

page = f"""<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<style>body{{margin:0}}[hidden]{{display:none!important}}</style>
{head}
</head>
<body>
{body.strip()}
</body>
</html>
"""
shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(OUT)
open(os.path.join(OUT, "index.html"), "w", encoding="utf-8").write(page)
shutil.copytree(os.path.join(HERE, "img"), os.path.join(OUT, "img"))
print("web/ generado")
