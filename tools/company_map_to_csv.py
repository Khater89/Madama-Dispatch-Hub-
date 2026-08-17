#!/usr/bin/env python3
"""Convert a FULL Google My Maps KML/KMZ export to MDAMA v10.3 company_techs CSV.

This writes only the independent Company ALL TECHS MAP schema. It does not
produce rows for the main technicians table. A tiny NetworkLink-only KMZ is
recognized and rejected with a clear message.
"""
from __future__ import annotations
import csv, hashlib, html, re, sys, zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NS={'k':'http://www.opengis.net/kml/2.2'}
MAP_ID='1rRbehqpWKWb0hY9nvQKPpsKy1MI1Oec'
VIEW_URL=f'https://www.google.com/maps/d/u/0/viewer?mid={MAP_ID}'
PHONE_RE=re.compile(r'(?:\+?1[\s().-]*)?(?:\(?\d{3}\)?[\s.-]*)\d{3}[\s.-]*\d{4}')
ZIP_RE=re.compile(r'\b\d{5}(?:-\d{4})?\b')
STATE_RE=re.compile(r'(?:,|\s)\s*(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b',re.I)
TRADES=[
 ('HVAC',re.compile(r'\bhvac\b|air\s*condition|heating|cooling',re.I)),
 ('Electrical',re.compile(r'electric',re.I)),('Plumber',re.compile(r'plumb|drain|sewer',re.I)),
 ('Handyman',re.compile(r'handyman|general\s*maintenance|general repair',re.I)),
 ('Appliance Repair',re.compile(r'appliance',re.I)),('Locksmith',re.compile(r'locksmith|\blocks?\b',re.I)),
 ('Glass Repair',re.compile(r'glass|glazier',re.I)),('Power Washing',re.compile(r'power\s*wash|pressure\s*wash',re.I)),
 ('Landscaping',re.compile(r'landscap|lawn',re.I)),('Snow Removal',re.compile(r'snow|plow',re.I)),
 ('Junk Removal',re.compile(r'junk|hauling',re.I)),
]

def clean_html(text:str)->str:
    text=html.unescape(text or '')
    text=re.sub(r'<br\s*/?>',' | ',text,flags=re.I)
    text=re.sub(r'<[^>]+>',' ',text)
    return re.sub(r'\s+',' ',text).strip()

def load_kml(path:Path)->bytes:
    if path.suffix.lower()=='.kmz':
        with zipfile.ZipFile(path) as z:
            names=[n for n in z.namelist() if n.lower().endswith('.kml')]
            if not names: raise SystemExit('No KML file was found inside this KMZ.')
            return z.read(names[0])
    return path.read_bytes()

def txt(node,xpath:str)->str:
    x=node.find(xpath,NS);return (x.text or '').strip() if x is not None and x.text else ''

def ext_data(node)->dict[str,str]:
    out={}
    for d in node.findall('.//k:ExtendedData/k:Data',NS):
        name=(d.attrib.get('name') or '').strip().lower();value=txt(d,'k:value')
        if name and value: out[name]=value
    for d in node.findall('.//k:ExtendedData/k:SchemaData/k:SimpleData',NS):
        name=(d.attrib.get('name') or '').strip().lower();value=(d.text or '').strip()
        if name and value: out[name]=value
    return out

def pick(d:dict[str,str],*keys:str)->str:
    for key in keys:
        key=key.lower()
        for k,v in d.items():
            if k==key or key in k:
                if v:return v
    return ''

def norm_phone(value:str)->str:
    m=PHONE_RE.search(value or '')
    if not m:return ''
    digits=re.sub(r'\D','',m.group(0))
    if len(digits)==11 and digits.startswith('1'):digits=digits[1:]
    return digits if len(digits)==10 else ''

def trade(value:str)->str:
    for label,rx in TRADES:
        if rx.search(value or ''):return label
    return ''

def layer_for(pm,parent_map:dict[int,str])->str:
    # ElementTree has no parent pointer; caller fills a placemark->folder lookup.
    return parent_map.get(id(pm),'')

def main()->None:
    if len(sys.argv)<2:raise SystemExit('Usage: company_map_to_csv.py <full-map.kml|full-map.kmz> [output.csv]')
    src=Path(sys.argv[1]);out=Path(sys.argv[2]) if len(sys.argv)>2 else src.with_name(src.stem+'_company_techs.csv')
    root=ET.fromstring(load_kml(src))
    placemarks=root.findall('.//k:Placemark',NS)
    if not placemarks:
        link=root.find('.//k:NetworkLink/k:Link/k:href',NS)
        if link is not None and (link.text or '').strip():
            raise SystemExit('This KMZ is only a Google My Maps NetworkLink. Use Sync Company Map in MDAMA, or export the FULL KML/KMZ containing Placemark pins.')
        raise SystemExit('No Placemark pins were found.')

    parent_layer={}
    for folder in root.findall('.//k:Folder',NS):
        lname=txt(folder,'k:name')
        for pm in folder.findall('.//k:Placemark',NS):parent_layer[id(pm)]=lname

    rows=[]
    for pm in placemarks:
        data=ext_data(pm);name=pick(data,'name','technician','tech','contact','title') or txt(pm,'k:name') or 'Unnamed company tech'
        desc=clean_html(txt(pm,'k:description'));address=pick(data,'address','full address','location','service address') or desc
        layer=layer_for(pm,parent_layer)
        blob=' | '.join([layer,name,desc,address]+[f'{k}: {v}' for k,v in data.items()])
        raw_phone=pick(data,'phone','phone number','telephone','mobile','cell');phone=norm_phone(raw_phone or blob)
        coords=txt(pm,'.//k:Point/k:coordinates').split(',');lon=lat=''
        if len(coords)>=2:lon,lat=coords[0].strip(),coords[1].strip()
        state=(pick(data,'state') or (STATE_RE.search(address+' '+blob).group(1) if STATE_RE.search(address+' '+blob) else '')).upper()[:2]
        z=pick(data,'zip','zipcode','zip code','postal code');zm=ZIP_RE.search(z or address+' '+blob);zip_code=zm.group(0)[:5] if zm else ''
        city=pick(data,'city')
        source_url=pick(data,'source url','url','website','facebook','facebook url') or VIEW_URL
        key_base='|'.join([MAP_ID,layer,name,lon,lat,address]).lower()
        rows.append({
            'map_key':hashlib.sha256(key_base.encode()).hexdigest(),'map_id':MAP_ID,'map_layer':layer,'name':name,
            'phone':raw_phone or phone,'normalized_phone':phone,'email':pick(data,'email','e-mail'),
            'primary_trade':trade(pick(data,'trade','primary trade','specialty','service','category') or layer or blob),
            'city':city,'state':state,'zip_code':zip_code,'latitude':lat,'longitude':lon,
            'rating':pick(data,'rating'),'reviews_count':pick(data,'reviews','reviews count','review count'),
            'map_address':address,'source_url':source_url,'notes':desc,'active':'true'
        })

    fields=['map_key','map_id','map_layer','name','phone','normalized_phone','email','primary_trade','city','state','zip_code','latitude','longitude','rating','reviews_count','map_address','source_url','notes','active']
    with out.open('w',newline='',encoding='utf-8-sig') as f:
        w=csv.DictWriter(f,fieldnames=fields);w.writeheader();w.writerows(rows)
    print(f'Wrote {len(rows)} independent company_techs rows to {out}')
    print(f'Rows with phone: {sum(bool(r["normalized_phone"]) for r in rows)}; rows with state: {sum(bool(r["state"]) for r in rows)}')

if __name__=='__main__':main()
