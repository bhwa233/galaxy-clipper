export function additionalCoverLayouts(root: string, portrait: boolean) {
  return `
${root}.chapter [data-cover-part="content"]{border-left:8px solid var(--accent);padding-left:4%;justify-content:flex-end}
${root}.chapter [data-cover-part="badge"]{font-size:2em;font-weight:900;line-height:1;color:var(--accent)}
${root}.keypoint [data-cover-part="badge"]{background:var(--accent);color:#101010;padding:.35em .8em;font-weight:900}
${root}.keypoint [data-cover-part="title"]{text-shadow:3px 4px 0 #000}
${root}.question [data-cover-part="content"]{background:var(--canvas);padding:4%;height:auto;max-height:85%;border-radius:18px;box-shadow:12px 12px 0 var(--accent)}
${root}.question [data-cover-part="badge"]{font-weight:900;border-bottom:3px solid var(--accent);padding-bottom:.3em}
${root}.speaker [data-cover-part="shade"]{background:linear-gradient(90deg,var(--canvas) 0%,var(--canvas) 43%,transparent 44%)}
${root}.speaker [data-cover-part="content"]{width:38%;left:5%;height:80%}
${root}.magazine [data-cover-part="content"]{border:2px solid white;padding:4%;width:88%;height:80%;justify-content:space-between}
${root}.magazine [data-cover-part="title"]{font-family:Georgia,GalaxyCover,serif;font-weight:600;text-shadow:1px 2px 8px #000}
${root}.data [data-cover-part="content"]{background:var(--canvas);padding:4%;border-top:12px solid var(--accent)}
${root}.data [data-cover-part="badge"]{font-size:2.8em;line-height:1;color:var(--accent);font-weight:900}
${root}.minimal [data-cover-part="photo"]{opacity:0}
${root}.minimal [data-cover-part="shade"]{background:linear-gradient(135deg,var(--canvas),var(--accent))}
${root}.minimal [data-cover-part="content"]{width:80%;left:10%;align-items:center;text-align:center}
${root}.shortvideo [data-cover-part="shade"]{background:linear-gradient(0deg,#000e 0%,transparent 45%,#000d 100%)}
${root}.shortvideo [data-cover-part="content"]{left:6%;top:5%;width:88%;height:85%;justify-content:space-between}
${root}.shortvideo [data-cover-part="title"]{text-shadow:2px 3px 8px #000}
${portrait ? `${root}.speaker [data-cover-part="shade"]{background:linear-gradient(180deg,var(--canvas) 0%,var(--canvas) 34%,transparent 60%)}
${root}.chapter [data-cover-part="content"]{height:50%}
${root}.speaker [data-cover-part="content"]{width:86%;left:7%;height:40%}
${root}.magazine [data-cover-part="content"],${root}.shortvideo [data-cover-part="content"]{left:6%;top:5%;width:88%;height:88%}
${root}.question [data-cover-part="content"]{width:82%;left:9%;height:auto}
${root}.minimal [data-cover-part="content"]{width:80%;left:10%;top:15%;height:70%;justify-content:center}
${root}.data [data-cover-part="content"]{height:42%}` : ''}
`
}
